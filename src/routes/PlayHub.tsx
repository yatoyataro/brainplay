import { useState } from "preact/hooks";
import { OptionsDrawer } from "../components/OptionsDrawer.tsx";
import type { MomentumStats } from "../core/mastery.ts";
import {
  ACTIVE_DIR_SHORT,
  aggregateLanguageTracks,
  buildSoloPlayUrl,
  HUB_CATEGORIES,
  isLanguageTrack,
  optionsFromPreferences,
  resolveSubtrackId,
} from "../core/options.ts";
import type {
  GameOptions,
  HubCategoryId,
  LanguageSubtrackId,
  PackCatalog,
  UserPreferencesV1,
} from "../core/types.ts";

interface PlayHubProps {
  catalog: PackCatalog | null;
  catalogError: string | null;
  storageWarning?: string | null;
  onDismissStorageWarning?: () => void;
  prefs: UserPreferencesV1;
  onChangePrefs: (patch: Partial<Omit<UserPreferencesV1, "schema_version">>) => void;
  momentum: MomentumStats;
  onNavigate: (path: string) => void;
  onRetryCatalog: () => void;
}

const CATEGORY_MODE_HINT: Record<HubCategoryId, string> = {
  languages: "KO & JA phrases with optional Romanization",
  "trivia-anime": "Studios, premieres & lore",
  "trivia-anime-characters": "Story roles, powers & iconic moments",
  "trivia-world": "Culture, science & geography",
};

export function PlayHub({
  catalog,
  catalogError,
  storageWarning,
  onDismissStorageWarning,
  prefs,
  onChangePrefs,
  momentum,
  onNavigate,
  onRetryCatalog,
}: PlayHubProps) {
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);

  const activeSubtrack = resolveSubtrackId(prefs.selectedCategory, prefs.languageSubtrack);
  const activeTrack = catalog?.tracks.find((t) => t.subtrack_id === activeSubtrack);
  const activeCatMeta = HUB_CATEGORIES.find((c) => c.id === prefs.selectedCategory);

  const langTotalItems = (catalog?.tracks ?? [])
    .filter((t) => isLanguageTrack(t.subtrack_id))
    .reduce((sum, t) => sum + t.item_count, 0);
  const langAgg = aggregateLanguageTracks(momentum.byTrack);

  const handleJoinByCode = (e: Event) => {
    e.preventDefault();
    const cleaned = joinCode.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(cleaned)) {
      setJoinError("Enter a valid 6-character room code (letters A-Z, digits 2-9).");
      return;
    }
    setJoinError(null);
    onNavigate(`/room/${cleaned}`);
  };

  const handleOptionsChange = (next: GameOptions) => {
    const patch: Partial<Omit<UserPreferencesV1, "schema_version">> = {
      difficulty: next.difficulty,
      sessionLength: next.sessionLength,
    };
    if (prefs.selectedCategory === "languages") {
      patch.romajiMode = next.romajiMode;
    }
    if (prefs.selectedCategory !== "trivia-anime-characters") {
      patch.shuffleCardsAndChoices = next.shuffleCardsAndChoices;
    }
    onChangePrefs(patch);
  };

  const handleLanguageDirectionChange = (languageSubtrack: LanguageSubtrackId) => {
    onChangePrefs({ languageSubtrack });
  };

  const buildRoomUrl = () => {
    const roomOpts = optionsFromPreferences(prefs, activeSubtrack, "room");
    const params = new URLSearchParams();
    params.set("track", activeSubtrack);
    if (roomOpts.difficulty !== "standard") params.set("diff", roomOpts.difficulty);
    if (roomOpts.sessionLength !== 5) params.set("len", String(roomOpts.sessionLength));
    if (isLanguageTrack(activeSubtrack) && roomOpts.romajiMode !== "subtle") {
      params.set("rom", roomOpts.romajiMode);
    }
    return `/room/new?${params.toString()}`;
  };

  const activeDots = momentum.days7;
  const drawerValue = optionsFromPreferences(prefs, activeSubtrack, "practice");

  return (
    <div class="stack">
      <div class="momentum-strip" aria-label="Learning momentum">
        <span>
          {momentum.totalActiveDays === 0
            ? "No signup, no energy bars — 5 cards in 3 min"
            : `${momentum.activeLast7Days} active days this week · ${momentum.learnedCount} learned`}
        </span>
        {momentum.dueReviewCount > 0 && (
          <button
            type="button"
            class="pill pill-warn"
            style="cursor: pointer;"
            onClick={() => onNavigate("/mastery")}
          >
            {momentum.dueReviewCount} due review
          </button>
        )}
      </div>

      {storageWarning && (
        <div
          class="banner banner-warn row"
          style="justify-content: space-between;"
          role="status"
          data-testid="storage-warning-banner"
        >
          <span>{storageWarning}</span>
          {onDismissStorageWarning && (
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onClick={onDismissStorageWarning}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {catalogError && (
        <div class="banner banner-err stack" role="alert">
          <p>{catalogError}</p>
          <button type="button" class="btn btn-secondary" onClick={onRetryCatalog}>
            Retry Loading Packs
          </button>
        </div>
      )}

      <div class="bento-grid">
        {/* Left / Primary Column */}
        <div class="bento-primary">
          {!catalog && !catalogError && (
            <div class="card stack" aria-busy="true" data-testid="hub-skeleton">
              <div class="skeleton skeleton-pill" />
              <div class="skeleton skeleton-title" />
              <div class="skeleton skeleton-line" />
              <div class="skeleton-grid">
                <div class="skeleton skeleton-box" />
                <div class="skeleton skeleton-box" />
                <div class="skeleton skeleton-box" />
                <div class="skeleton skeleton-box" />
              </div>
            </div>
          )}

          {catalog && (
            <section class="card card-hero stack" aria-labelledby="daily-heading">
              <div class="row" style="justify-content: space-between;">
                <span class="pill pill-ok">100% Free &amp; Offline-Capable</span>
                {momentum.todayCompleted && <span class="pill">✓ Daily Played Today</span>}
              </div>

              <h1 id="daily-heading" class="h1">
                Today&apos;s 5-Card Ritual
              </h1>
              <p class="muted">
                {activeTrack?.description ??
                  activeCatMeta?.description ??
                  "Pick a category below for a forgiving 3-minute brain spark."}
              </p>

              <div class="stack">
                <span class="field-label" id="track-picker-label">
                  Choose Category ({catalog.total_items.toLocaleString()} curated cards)
                </span>
                <div class="track-grid track-grid-4" role="group" aria-labelledby="track-picker-label">
                  {HUB_CATEGORIES.map((cat, idx) => {
                    const isLang = cat.id === "languages";
                    const itemCount = isLang
                      ? langTotalItems
                      : catalog.tracks.find((t) => t.subtrack_id === cat.id)?.item_count ?? 0;
                    const learned = isLang
                      ? langAgg.learned
                      : momentum.byTrack[cat.id]?.learned ?? 0;
                    const progressScale = Math.min(
                      1,
                      Math.max(0.04, learned / Math.max(1, itemCount))
                    );

                    return (
                      <button
                        key={cat.id}
                        type="button"
                        class="track-chip"
                        style={`--stagger: ${idx}`}
                        data-testid={`category-card-${cat.id}`}
                        aria-pressed={prefs.selectedCategory === cat.id}
                        onClick={() => onChangePrefs({ selectedCategory: cat.id })}
                      >
                        <div class="track-chip-top">
                          <span class="track-badge">
                            <span aria-hidden="true">{cat.badge}</span>
                            <span>{cat.accentLabel}</span>
                          </span>
                          <span class="muted" style="font-size: 0.76rem; font-variant-numeric: tabular-nums;">
                            {itemCount} cards
                          </span>
                        </div>
                        <div>{isLang ? "Languages" : cat.label}</div>
                        {isLang && (
                          <div class="track-config-cue" data-testid="languages-config-cue">
                            Active: {ACTIVE_DIR_SHORT[prefs.languageSubtrack]} · Change in Options
                          </div>
                        )}
                        <div class="track-chip-meta">
                          <span>{learned > 0 ? `${learned} learned` : CATEGORY_MODE_HINT[cat.id]}</span>
                        </div>
                        {learned > 0 && (
                          <div class="mini-progress" aria-hidden="true">
                            <div
                              class="mini-progress-fill"
                              style={`transform: scaleX(${progressScale})`}
                            />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 1-Click Default Play Priority */}
              <div class="row">
                <button
                  type="button"
                  class="btn btn-primary"
                  style="flex: 1 1 200px;"
                  onClick={() =>
                    onNavigate(
                      buildSoloPlayUrl(
                        "daily",
                        activeSubtrack,
                        optionsFromPreferences(prefs, activeSubtrack, "daily")
                      )
                    )
                  }
                >
                  Play Today&apos;s 5
                </button>
                <button
                  type="button"
                  class="btn btn-secondary"
                  style="flex: 1 1 170px;"
                  onClick={() =>
                    onNavigate(
                      buildSoloPlayUrl(
                        "practice",
                        activeSubtrack,
                        optionsFromPreferences(prefs, activeSubtrack, "practice")
                      )
                    )
                  }
                >
                  Unlimited Practice ({prefs.sessionLength} cards)
                </button>
              </div>

              {/* Collapsible / Sliding Advanced Options Drawer */}
              <OptionsDrawer
                selectedCategory={prefs.selectedCategory}
                languageSubtrack={prefs.languageSubtrack}
                onChangeLanguageSubtrack={handleLanguageDirectionChange}
                value={drawerValue}
                onChange={handleOptionsChange}
                context="solo"
              />
            </section>
          )}
        </div>

        {/* Right / Companion Column */}
        <aside class="bento-companion" aria-label="Multiplayer and progress overview">
          <section class="card stack" aria-labelledby="friends-heading">
            <div class="row" style="justify-content: space-between;">
              <h2 id="friends-heading" class="h2">
                Play with Friends (2–50 Free)
              </h2>
              <span class="pill">Live or 24h Async</span>
            </div>
            <p class="muted">
              Share one invite link — zero guest accounts, zero 10-player paywalls, reconnect-safe.
            </p>

            <div class="card-subtle stack" style="gap: 8px;">
              <div>
                <strong>Live Sync:</strong>{" "}
                <span class="muted" style="font-size: 0.875rem;">
                  Everyone plays together in real time; answers stay locked until all players answer, then everyone clicks Ready to advance together.
                </span>
              </div>
              <div>
                <strong>24h Micro-Async:</strong>{" "}
                <span class="muted" style="font-size: 0.875rem;">
                  Play at your own pace anytime within 24 hours with instant feedback; peer scores stay hidden until you finish your full run.
                </span>
              </div>
            </div>

            <button
              type="button"
              class="btn btn-primary btn-block"
              onClick={() => onNavigate(buildRoomUrl())}
            >
              Create Room
            </button>

            <form class="row" onSubmit={handleJoinByCode} novalidate>
              <div style="flex: 1 1 160px;">
                <label class="sr-only" htmlFor="hub-room-code">
                  6-character room code
                </label>
                <input
                  id="hub-room-code"
                  class="input"
                  type="text"
                  inputMode="text"
                  maxLength={6}
                  placeholder="Room code (e.g. K7M9P2)"
                  value={joinCode}
                  onInput={(e) => setJoinCode((e.currentTarget as HTMLInputElement).value.toUpperCase())}
                />
              </div>
              <button type="submit" class="btn btn-secondary">
                Join Code
              </button>
            </form>
            {joinError && (
              <p class="muted" style="color: var(--err-ink);" role="alert">
                {joinError}
              </p>
            )}
          </section>

          <section class="card stack" aria-labelledby="snapshot-heading">
            <div class="row" style="justify-content: space-between;">
              <h2 id="snapshot-heading" class="h2">
                Daily Progress &amp; How Modes Work
              </h2>
              <span class="pill">Solo = 0 Server Hits</span>
            </div>

            <div class="week-strip" aria-label="7-day rolling activity">
              {activeDots.map((d) => {
                const hPct = Math.min(100, d.cards > 0 ? Math.max(22, d.cards * 10) : 0);
                return (
                  <div key={d.date} class="day-col" title={`${d.label}: ${d.cards} cards`}>
                    <div class="day-bar-wrap" aria-hidden="true">
                      <div class="day-bar-fill" style={`transform: scaleY(${hPct / 100})`} />
                    </div>
                    <span class="day-label">{d.label}</span>
                  </div>
                );
              })}
            </div>

            <div class="row" style="justify-content: space-between;">
              <span class="muted" style="font-size: 0.875rem;">
                {momentum.masteredCount} mastered · {momentum.learnedCount} learned
                {momentum.recentAccuracyPct !== null ? ` · ${momentum.recentAccuracyPct}% recent accuracy` : ""}
              </span>
              <button type="button" class="btn btn-secondary" onClick={() => onNavigate("/mastery")}>
                Open Mastery
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
