import { useEffect, useState } from "preact/hooks";
import { OptionsDrawer } from "../components/OptionsDrawer.tsx";
import {
  ACTIVE_DIR_SHORT,
  buildSoloPlayUrl,
  categoryFromSubtrack,
  HUB_CATEGORIES,
  isLanguageTrack,
  LANGUAGE_SUBTRACK_IDS,
  loadUserPreferences,
  normalizeDifficulty,
  normalizeRomajiMode,
  normalizeSessionLength,
  optionsFromPreferences,
  resolveSubtrackId,
  saveUserPreferences,
} from "../core/options.ts";
import { ApiRequestError, apiCreateRoom } from "../core/roomClient.ts";
import type {
  GameOptions,
  HubCategoryId,
  LanguageSubtrackId,
  PackCatalog,
  PacingMode,
  UserPreferencesV1,
} from "../core/types.ts";

interface RoomNewProps {
  catalog: PackCatalog | null;
  defaultTrack: string;
  search?: string;
  prefs?: UserPreferencesV1;
  onChangePrefs?: (patch: Partial<Omit<UserPreferencesV1, "schema_version">>) => void;
  onNavigate: (path: string) => void;
}

const CATEGORY_MODE_HINT: Record<HubCategoryId, string> = {
  languages: "KO & JA bidirectional phrases",
  "trivia-anime": "Studios, premieres & lore",
  "trivia-anime-characters": "Story roles, powers & iconic moments",
  "trivia-world": "Culture, science & geography",
};

export function RoomNew({
  catalog,
  defaultTrack,
  search = "",
  prefs,
  onChangePrefs,
  onNavigate,
}: RoomNewProps) {
  const initParams = new URLSearchParams(search);
  const storedPrefs = prefs ?? loadUserPreferences();
  const initialTrackParam = initParams.get("track") ?? defaultTrack;

  const [category, setCategory] = useState<HubCategoryId>(() =>
    initParams.has("track") ? categoryFromSubtrack(initialTrackParam) : storedPrefs.selectedCategory
  );
  const [languageSubtrack, setLanguageSubtrack] = useState<LanguageSubtrackId>(() => {
    if (
      isLanguageTrack(initialTrackParam) &&
      (LANGUAGE_SUBTRACK_IDS as readonly string[]).includes(initialTrackParam)
    ) {
      return initialTrackParam as LanguageSubtrackId;
    }
    return storedPrefs.languageSubtrack;
  });

  const [options, setOptions] = useState<GameOptions>(() => {
    const resolvedInit = resolveSubtrackId(
      initParams.has("track") ? categoryFromSubtrack(initialTrackParam) : storedPrefs.selectedCategory,
      isLanguageTrack(initialTrackParam) &&
        (LANGUAGE_SUBTRACK_IDS as readonly string[]).includes(initialTrackParam)
        ? (initialTrackParam as LanguageSubtrackId)
        : storedPrefs.languageSubtrack
    );
    const base = optionsFromPreferences(storedPrefs, resolvedInit, "room");
    return {
      ...base,
      difficulty: initParams.has("diff")
        ? normalizeDifficulty(initParams.get("diff"))
        : base.difficulty,
      sessionLength: initParams.has("len")
        ? normalizeSessionLength(Number(initParams.get("len")))
        : base.sessionLength,
      romajiMode:
        isLanguageTrack(resolvedInit) && initParams.has("rom")
          ? normalizeRomajiMode(initParams.get("rom"))
          : base.romajiMode,
    };
  });

  const [pacingMode, setPacingMode] = useState<PacingMode>("live");
  const [maxPlayers, setMaxPlayers] = useState(30);
  const [roundSeconds, setRoundSeconds] = useState(() =>
    options.difficulty === "harder" ? 15 : 25
  );
  const [hostName, setHostName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quotaReached, setQuotaReached] = useState(false);
  const [resetAtUtc, setResetAtUtc] = useState<string | null>(null);
  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);
  const [showSoloFallback, setShowSoloFallback] = useState(false);

  useEffect(() => {
    if (retryAfterSec === null || retryAfterSec <= 0) return;
    const id = window.setInterval(() => {
      setRetryAfterSec((s) => (s !== null && s > 1 ? s - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [retryAfterSec]);

  const persistPrefs = (patch: Partial<Omit<UserPreferencesV1, "schema_version">>) => {
    if (onChangePrefs) onChangePrefs(patch);
    else saveUserPreferences(patch);
  };

  const handleCategoryChange = (nextCategory: HubCategoryId) => {
    setCategory(nextCategory);
    persistPrefs({ selectedCategory: nextCategory });
  };

  const handleLanguageSubtrackChange = (nextSubtrack: LanguageSubtrackId) => {
    setLanguageSubtrack(nextSubtrack);
    persistPrefs({ languageSubtrack: nextSubtrack });
  };

  const handleOptionsChange = (next: GameOptions) => {
    if (next.difficulty !== options.difficulty) {
      setRoundSeconds(next.difficulty === "harder" ? 15 : 25);
    }
    setOptions(next);
    const patch: Partial<Omit<UserPreferencesV1, "schema_version">> = {
      difficulty: next.difficulty,
      sessionLength: next.sessionLength,
    };
    if (category === "languages") {
      patch.romajiMode = next.romajiMode;
    }
    persistPrefs(patch);
  };

  const resolvedTrackId = resolveSubtrackId(category, languageSubtrack);
  const langTotalItems = (catalog?.tracks ?? [])
    .filter((t) => isLanguageTrack(t.subtrack_id))
    .reduce((sum, t) => sum + t.item_count, 0);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setErrorMsg(null);
    setQuotaReached(false);
    setResetAtUtc(null);
    setRetryAfterSec(null);
    setShowSoloFallback(false);

    const trimmed = hostName.trim();
    if (trimmed.length < 2 || trimmed.length > 20) {
      setErrorMsg("Enter a host display name (2 to 20 characters).");
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiCreateRoom({
        trackId: resolvedTrackId,
        pacingMode,
        maxPlayers,
        roundSeconds,
        questionCount: options.sessionLength,
        difficulty: options.difficulty,
        hostName: trimmed,
      });
      if (category === "languages") {
        try {
          sessionStorage.setItem(`prb005_rom_${res.roomCode}`, options.romajiMode);
        } catch {
          // Ignore storage restriction
        }
      }
      onNavigate(`/room/${res.roomCode}`);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (
          err.status === 503 ||
          err.payload.code === "DAILY_QUOTA_REACHED" ||
          err.payload.code === "SERVICE_UNAVAILABLE" ||
          err.payload.fallback === "solo"
        ) {
          setQuotaReached(true);
          setResetAtUtc(err.payload.resetAtUtc ?? null);
          setErrorMsg(err.payload.error);
        } else if (err.status === 429 || err.payload.code === "RATE_LIMITED") {
          setRetryAfterSec(err.payload.retryAfterSec ?? 60);
          setShowSoloFallback(true);
          setErrorMsg(err.payload.error);
        } else if (err.payload?.code === "ORIGIN_FORBIDDEN") {
          setErrorMsg(
            "Room creation blocked by origin security check. Reload from the main app URL and try again."
          );
        } else if (err.status === 0 || err.payload.code === "NETWORK_ERROR") {
          setShowSoloFallback(true);
          setErrorMsg(
            "Unable to reach multiplayer servers right now. Check your connection or play Solo offline."
          );
        } else {
          setErrorMsg(err.payload.error || "Could not create room.");
        }
      } else {
        setErrorMsg(err instanceof Error ? err.message : "Could not create room.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openSoloDaily = () =>
    onNavigate(
      buildSoloPlayUrl(
        "daily",
        resolvedTrackId,
        optionsFromPreferences(loadUserPreferences(), resolvedTrackId, "daily")
      )
    );

  const formattedResetUtc =
    resetAtUtc && !Number.isNaN(Date.parse(resetAtUtc))
      ? new Date(resetAtUtc).toUTCString()
      : resetAtUtc;

  return (
    <section class="card stack" aria-labelledby="new-room-title">
      <h1 id="new-room-title" class="h1">
        Create a Friend Room
      </h1>
      <p class="muted">
        Free for 2–50 players. Share one link — guests join in 2 taps with no signup.
      </p>

      {quotaReached && (
        <div class="banner banner-warn stack" role="alert" data-testid="quota-fallback-banner">
          <strong>Live rooms at today&apos;s free-tier safety cap</strong>
          <p>{errorMsg}</p>
          {formattedResetUtc && (
            <p class="muted" style="font-size: 0.85rem;">
              Daily reset (UTC): {formattedResetUtc}
            </p>
          )}
          <button type="button" class="btn btn-primary" onClick={openSoloDaily}>
            Play Solo Daily (100% Available Offline)
          </button>
        </div>
      )}

      {errorMsg && !quotaReached && (
        <div class="banner banner-err stack" role="alert">
          <p>{errorMsg}</p>
          {retryAfterSec !== null && (
            <p class="muted" style="font-size: 0.875rem;" data-testid="room-rate-countdown">
              {retryAfterSec > 0
                ? `Try again in ${retryAfterSec}s.`
                : "Cooldown complete — you can retry now."}
            </p>
          )}
          {showSoloFallback && (
            <div class="row">
              <button type="button" class="btn btn-secondary" onClick={openSoloDaily}>
                Play Solo Daily (100% Available Offline)
              </button>
            </div>
          )}
        </div>
      )}

      <form class="stack" onSubmit={handleSubmit} novalidate>
        <div class="stack">
          <span class="field-label" id="room-category-label">
            Category / Track
          </span>
          <div class="track-grid track-grid-4" role="group" aria-labelledby="room-category-label">
            {HUB_CATEGORIES.map((cat, idx) => {
              const isLang = cat.id === "languages";
              const itemCount = isLang
                ? langTotalItems
                : catalog?.tracks.find((t) => t.subtrack_id === cat.id)?.item_count ?? 0;
              return (
                <button
                  key={cat.id}
                  type="button"
                  class="track-chip"
                  style={`--stagger: ${idx}`}
                  data-testid={`room-category-card-${cat.id}`}
                  aria-pressed={category === cat.id}
                  onClick={() => handleCategoryChange(cat.id)}
                >
                  <div class="track-chip-top">
                    <span class="track-badge">
                      <span aria-hidden="true">{cat.badge}</span>
                      <span>{cat.accentLabel}</span>
                    </span>
                    {catalog && (
                      <span class="muted" style="font-size: 0.76rem; font-variant-numeric: tabular-nums;">
                        {itemCount} cards
                      </span>
                    )}
                  </div>
                  <div>{isLang ? "Languages" : cat.label}</div>
                  {isLang && (
                    <div class="track-config-cue" data-testid="room-languages-config-cue">
                      Active: {ACTIVE_DIR_SHORT[languageSubtrack]} · Change in Options
                    </div>
                  )}
                  <div class="track-chip-meta">
                    <span>{CATEGORY_MODE_HINT[cat.id]}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div class="stack">
          <span class="field-label" id="pacing-label">
            Room Pacing Mode
          </span>
          <div class="track-grid" role="group" aria-labelledby="pacing-label">
            <button
              type="button"
              class="track-chip"
              aria-pressed={pacingMode === "live"}
              onClick={() => setPacingMode("live")}
            >
              <div>Live Sync</div>
              <div class="muted" style="font-size: 0.8rem; font-weight: 500;">
                Everyone plays together in real time; answers stay locked and hidden until all players answer, then everyone clicks Ready for next round together.
              </div>
            </button>
            <button
              type="button"
              class="track-chip"
              aria-pressed={pacingMode === "async24h"}
              onClick={() => setPacingMode("async24h")}
            >
              <div>24h Micro-Async</div>
              <div class="muted" style="font-size: 0.8rem; font-weight: 500;">
                Play {options.sessionLength} cards anytime within 24 hours at your own pace with instant feedback; peer standings stay hidden until you finish all {options.sessionLength} cards.
              </div>
            </button>
          </div>
        </div>

        <div class="row">
          <div style="flex: 1 1 140px;">
            <label class="field-label" htmlFor="room-max-players">
              Max Players (2–50)
            </label>
            <input
              id="room-max-players"
              class="input"
              type="number"
              min={2}
              max={50}
              value={maxPlayers}
              onInput={(e) => setMaxPlayers(Number((e.currentTarget as HTMLInputElement).value))}
            />
          </div>
          {pacingMode === "live" && (
            <div style="flex: 1 1 140px;">
              <label class="field-label" htmlFor="room-seconds">
                Seconds / Card (15–45)
              </label>
              <input
                id="room-seconds"
                class="input"
                type="number"
                min={15}
                max={45}
                value={roundSeconds}
                onInput={(e) => setRoundSeconds(Number((e.currentTarget as HTMLInputElement).value))}
              />
            </div>
          )}
        </div>

        <OptionsDrawer
          selectedCategory={category}
          languageSubtrack={languageSubtrack}
          onChangeLanguageSubtrack={handleLanguageSubtrackChange}
          value={options}
          onChange={handleOptionsChange}
          context="room"
        />

        <div>
          <label class="field-label" htmlFor="host-display-name">
            Your Display Name (2–20 chars)
          </label>
          <input
            id="host-display-name"
            class="input"
            type="text"
            maxLength={20}
            placeholder="e.g. Devon"
            value={hostName}
            onInput={(e) => setHostName((e.currentTarget as HTMLInputElement).value)}
          />
        </div>

        <p class="muted" style="font-size: 0.85rem;">
          Zero-PII note: Only your display name is shared inside this room for up to 48 hours.
        </p>

        <div class="row">
          <button type="submit" class="btn btn-primary" style="flex: 1 1 180px;" disabled={submitting}>
            {submitting ? "Creating Room..." : `Create Room (${options.sessionLength} cards)`}
          </button>
          <button type="button" class="btn btn-secondary" onClick={() => onNavigate("/")}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
