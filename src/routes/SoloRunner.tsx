import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { LeaveGuardConfig } from "../components/ConfirmLeaveModal.tsx";
import { FlagButton } from "../components/FlagButton.tsx";
import { createSessionNonce, cryptoRandomFloat } from "../core/entropy.ts";
import { lazyComponent } from "../core/lazyRoute.tsx";
import {
  applySessionCardOrderAndChoices,
  getLocalDateIso,
  getUtcDateIso,
  scheduleNextMastery,
  selectPracticeCards,
} from "../core/mastery.ts";
import {
  buildSoloPlayUrl,
  extractCarriedPracticeLength,
  isLanguageTrack,
  parseSoloOptionsFromSearch,
  resolveTrackShuffle,
} from "../core/options.ts";
import { loadDailyRound, loadSubtrackItems } from "../core/packsClient.ts";
import { buildSpoilerFreeShareText, type RoundEmojiOutcome } from "../core/shareGrid.ts";
import type { ContentShardItem, LocalMasteryItem, PackCatalog } from "../core/types.ts";

const LazyShareBox = lazyComponent(
  () => import("../components/ShareModal.tsx").then((m) => m.ShareBox),
  "Loading share box"
);

interface SoloRunnerProps {
  mode: "daily" | "practice";
  subtrackId: string;
  search?: string;
  catalog: PackCatalog | null;
  masteryMap: Map<string, LocalMasteryItem>;
  onRecordAnswer: (
    updated: LocalMasteryItem,
    completedRoundGrid?: string,
    isCorrect?: boolean
  ) => Promise<void>;
  onFlagItemLocally: (itemId: string) => Promise<void>;
  onNavigate: (path: string) => void;
  onSetLeaveGuard?: (guard: LeaveGuardConfig | null) => void;
  onRequestLeaveAction?: (action: () => void | Promise<void>) => void;
}

const HARDER_SECONDS = 15;

export function SoloRunner({
  mode,
  subtrackId,
  search = "",
  catalog,
  masteryMap,
  onRecordAnswer,
  onFlagItemLocally,
  onNavigate,
  onSetLeaveGuard,
  onRequestLeaveAction,
}: SoloRunnerProps) {
  const options = useMemo(
    () => parseSoloOptionsFromSearch(search, subtrackId, mode),
    [search, subtrackId, mode]
  );

  const [cards, setCards] = useState<ContentShardItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [outcomes, setOutcomes] = useState<RoundEmojiOutcome[]>([]);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const [roundKey, setRoundKey] = useState(0);
  const [sessionNonce, setSessionNonce] = useState(() => createSessionNonce());
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const trackLabel =
    catalog?.tracks.find((t) => t.subtrack_id === subtrackId)?.label ?? subtrackId;
  const utcDate = getUtcDateIso();

  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        setSessionNonce(createSessionNonce());
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCards(null);
    setLoadError(null);
    setIndex(0);
    setChosen(null);
    setOutcomes([]);

    const hiddenIds = new Set(
      Array.from(masteryMap.values())
        .filter((m) => m.flagged_hidden)
        .map((m) => m.item_id)
    );

    const load = async () => {
      try {
        const shuffleEnabled = resolveTrackShuffle(subtrackId, options.shuffleCardsAndChoices);
        let picked: ContentShardItem[];
        if (mode === "daily") {
          const base = await loadDailyRound(subtrackId, utcDate, hiddenIds);
          picked = applySessionCardOrderAndChoices(base, shuffleEnabled, cryptoRandomFloat);
        } else {
          const pool = await loadSubtrackItems(subtrackId);
          picked = selectPracticeCards(
            pool,
            masteryMap,
            getLocalDateIso(),
            options.sessionLength,
            options.difficulty,
            shuffleEnabled,
            cryptoRandomFloat
          );
        }
        if (!cancelled) {
          setCards(picked);
          if (picked[0]) {
            setLiveAnnouncement(`Card 1 of ${picked.length}: ${picked[0].prompt}`);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load cards. Check connection or retry."
          );
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    mode,
    subtrackId,
    utcDate,
    roundKey,
    sessionNonce,
    options.difficulty,
    options.sessionLength,
    options.shuffleCardsAndChoices,
  ]);

  const currentCard = cards && index < cards.length ? cards[index] : null;
  const finished = cards !== null && cards.length > 0 && index >= cards.length;
  const isSoloActiveSession = Boolean(
    cards && cards.length > 0 && !finished && !loadError && (index > 0 || chosen !== null)
  );

  useEffect(() => {
    onSetLeaveGuard?.(isSoloActiveSession ? { active: true, context: "solo" } : null);
  }, [isSoloActiveSession, onSetLeaveGuard]);

  useEffect(() => {
    return () => {
      onSetLeaveGuard?.(null);
    };
  }, [onSetLeaveGuard]);

  const keyActionRef = useRef<{
    hasCard: boolean;
    chosen: number | null;
    onChoose: (idx: number) => void;
    onAdvance: () => void;
  }>({
    hasCard: false,
    chosen: null,
    onChoose: () => {},
    onAdvance: () => {},
  });

  const handleChoose = async (optIdx: number) => {
    if (!currentCard || chosen !== null) return;
    keyActionRef.current.chosen = optIdx;
    setChosen(optIdx);
    const isCorrect = optIdx >= 0 && optIdx === currentCard.correct_index;
    const nextOutcome: RoundEmojiOutcome = isCorrect ? "correct" : "wrong";
    const nextOutcomes = [...outcomes, nextOutcome];
    setOutcomes(nextOutcomes);

    const updated = scheduleNextMastery(
      masteryMap.get(currentCard.item_id),
      currentCard.item_id,
      currentCard.subtrack_id,
      isCorrect,
      getLocalDateIso()
    );

    const isLastCard = cards !== null && index + 1 >= cards.length;
    const gridSummary =
      isLastCard && mode === "daily"
        ? nextOutcomes.map((o) => (o === "correct" ? "🟩" : "🟨")).join("")
        : undefined;

    setLiveAnnouncement(
      isCorrect
        ? `Correct! ${currentCard.deterministic_note}`
        : `Your answer is wrong. Correct answer: ${currentCard.options_4[currentCard.correct_index]}. ${currentCard.deterministic_note}`
    );

    try {
      await onRecordAnswer(updated, gridSummary, isCorrect);
    } catch {
      // Storage degradation banner is surfaced via onStorageError
    }
  };

  const handleAdvance = () => {
    if (!cards || chosen === null) return;
    keyActionRef.current.chosen = null;
    const nextIdx = index + 1;
    setIndex(nextIdx);
    setChosen(null);
    if (nextIdx < cards.length && cards[nextIdx]) {
      setLiveAnnouncement(`Card ${nextIdx + 1} of ${cards.length}: ${cards[nextIdx]!.prompt}`);
    } else {
      setLiveAnnouncement("Round complete.");
    }
  };

  // Optional 15s countdown in Harder difficulty
  useEffect(() => {
    if (options.difficulty !== "harder" || !currentCard || chosen !== null) {
      setSecondsLeft(null);
      return;
    }
    setSecondsLeft(HARDER_SECONDS);
    let remaining = HARDER_SECONDS;
    const timer = window.setInterval(() => {
      remaining -= 1;
      setSecondsLeft(Math.max(0, remaining));
      if (remaining <= 0) {
        window.clearInterval(timer);
        void handleChoose(-1);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [options.difficulty, currentCard?.item_id, chosen]);

  const handleFlagLocally = async (itemId: string) => {
    try {
      await onFlagItemLocally(itemId);
    } catch {
      // Storage warning is surfaced via onStorageError
    }
    if (chosen === null && cards) {
      const nextOutcomes = [...outcomes, "skipped" as const];
      setOutcomes(nextOutcomes);
      setIndex((prev) => prev + 1);
      setChosen(null);
    }
  };

  keyActionRef.current = {
    hasCard: currentCard !== null,
    chosen,
    onChoose: (idx: number) => {
      void handleChoose(idx);
    },
    onAdvance: handleAdvance,
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const snap = keyActionRef.current;
      if (!snap.hasCard) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (snap.chosen === null && (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4")) {
        e.preventDefault();
        snap.onChoose(Number(e.key) - 1);
      } else if (snap.chosen !== null && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        snap.onAdvance();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (loadError) {
    return (
      <div class="card stack" role="alert">
        <h1 class="h2">Unable to load cards</h1>
        <p class="muted">{loadError}</p>
        <div class="row">
          <button
            type="button"
            class="btn btn-primary"
            onClick={() => {
              setSessionNonce(createSessionNonce());
              setRoundKey((k) => k + 1);
            }}
          >
            Retry
          </button>
          <button type="button" class="btn btn-secondary" onClick={() => onNavigate("/")}>
            Back to Hub
          </button>
        </div>
      </div>
    );
  }

  if (cards === null) {
    return (
      <div class="card stack" aria-busy="true" data-testid="solo-skeleton">
        <div class="skeleton skeleton-pill" />
        <div class="skeleton skeleton-title" />
        <div class="skeleton skeleton-line" />
        <div class="skeleton skeleton-box" />
        <div class="skeleton skeleton-box" />
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div class="card stack">
        <h1 class="h2">All cards cleared or hidden</h1>
        <p class="muted">Play another track or restore hidden cards in My Mastery.</p>
        <button type="button" class="btn btn-primary" onClick={() => onNavigate("/")}>
          Back to Hub
        </button>
      </div>
    );
  }

  if (finished) {
    const score = outcomes.filter((o) => o === "correct").length;
    const shareText = buildSpoilerFreeShareText({
      title: `BrainPlay · ${trackLabel}`,
      dateOrRoom: mode === "daily" ? utcDate : "Practice",
      outcomes,
      url: typeof window !== "undefined" ? window.location.origin : "",
    });

    return (
      <section class="card stack" aria-labelledby="solo-summary-title">
        <div class="sr-only" aria-live="polite">
          {liveAnnouncement}
        </div>
        <span class="pill pill-ok">
          {mode === "daily" ? "Daily 5-Card Ritual Complete" : `Practice (${cards.length} Cards) Complete`}
        </span>
        <h1 id="solo-summary-title" class="h1">
          {score} / {cards.length} Warmth Earned
        </h1>
        <p class="muted">
          Missed cards are gently scheduled sooner in your local Mastery Ledger — zero streak wipe, zero energy limit.
        </p>

        <LazyShareBox shareText={shareText} />

        <div class="row">
          <button
            type="button"
            class="btn btn-primary"
            style="flex: 1 1 160px;"
            onClick={() => {
              const resetRound = () => {
                if (mode === "daily") {
                  onNavigate(
                    buildSoloPlayUrl("practice", subtrackId, {
                      ...options,
                      sessionLength: extractCarriedPracticeLength(search),
                    })
                  );
                } else {
                  setSessionNonce(createSessionNonce());
                  setRoundKey((k) => k + 1);
                }
              };
              if (onRequestLeaveAction && isSoloActiveSession) {
                onRequestLeaveAction(resetRound);
              } else {
                resetRound();
              }
            }}
          >
            {mode === "daily" ? "Play Extra Practice" : `Play ${cards.length} More Cards`}
          </button>
          <button type="button" class="btn btn-secondary" onClick={() => onNavigate("/mastery")}>
            View Mastery
          </button>
          <button type="button" class="btn btn-secondary" onClick={() => onNavigate("/")}>
            Back to Hub
          </button>
        </div>
      </section>
    );
  }

  const showRomaji =
    isLanguageTrack(subtrackId) &&
    (options.romajiMode === "subtle" || (options.romajiMode === "after_answer" && chosen !== null));

  return (
    <section class="card stack" aria-label="Solo card runner">
      <div class="sr-only" aria-live="polite">
        {liveAnnouncement}
      </div>

      <div class="runner-header">
        <div class="dots" aria-label={`Card ${index + 1} of ${cards.length}`}>
          {cards.map((c, idx) => {
            const out = outcomes[idx];
            const cls =
              out === "correct"
                ? "dot dot-correct"
                : out === "wrong"
                ? "dot dot-wrong"
                : idx === index
                ? "dot dot-current"
                : "dot";
            return <span key={`${c.item_id}-${idx}`} class={cls} />;
          })}
          <span class="muted" style="margin-left: 6px; font-variant-numeric: tabular-nums;">
            {index + 1}/{cards.length}
          </span>
        </div>
        <div class="row" style="gap: 6px;">
          {secondsLeft !== null && (
            <span class={`pill ${secondsLeft <= 5 ? "pill-warn" : ""}`} data-testid="solo-timer">
              {secondsLeft}s
            </span>
          )}
          <span class="pill">
            {mode === "daily" ? "Daily Ritual" : "Practice"}
            {options.difficulty === "harder" ? " · Harder" : ""}
          </span>
          <button
            type="button"
            class="btn btn-secondary btn-sm btn-leave"
            data-testid="solo-leave-btn"
            onClick={() => onNavigate("/")}
          >
            Leave
          </button>
        </div>
      </div>

      <div key={`solo-${currentCard!.item_id}-${index}`} class="card-stage stack">
        <div class="muted" style="font-size: 0.85rem;">
          {isLanguageTrack(subtrackId) ? `Languages · ${trackLabel}` : trackLabel} ·{" "}
          {currentCard!.difficulty}
        </div>

        <div>
          <h1 class="prompt-text">{currentCard!.prompt}</h1>
          {showRomaji && currentCard!.prompt_romanization && (
            <span class="romanization" data-testid="prompt-romanization">
              {currentCard!.prompt_romanization}
            </span>
          )}
        </div>

        <div class="options-list" role="group" aria-label="Answer choices (keys 1 to 4)">
          {currentCard!.options_4.map((opt, optIdx) => {
            const isPicked = chosen === optIdx;
            const isRight = chosen !== null && optIdx === currentCard!.correct_index;
            const isWrongPick = isPicked && chosen !== currentCard!.correct_index;
            const optRom = currentCard!.options_romanization?.[optIdx];
            const cls = isRight
              ? "option-btn correct"
              : isWrongPick
              ? "option-btn wrong"
              : isPicked
              ? "option-btn selected"
              : "option-btn";

            return (
              <button
                key={`${currentCard!.item_id}-${optIdx}`}
                type="button"
                class={cls}
                disabled={chosen !== null}
                onClick={() => void handleChoose(optIdx)}
              >
                <span class="option-kbd">{optIdx + 1}</span>
                <span>
                  <span>
                    {opt}
                    {isRight ? " ✓" : isWrongPick ? " ✗" : ""}
                  </span>
                  {showRomaji && optRom && <span class="option-romanization">{optRom}</span>}
                </span>
              </button>
            );
          })}
        </div>

        {chosen !== null && (
          <div
            class={`banner ${
              chosen === currentCard!.correct_index ? "banner-ok" : "banner-err"
            } stack`}
            data-testid="solo-feedback-banner"
          >
            <strong>
              {chosen === currentCard!.correct_index
                ? "✓ Correct! Scheduled forward"
                : chosen === -1
                ? `⏱ Time's up — correct answer: "${currentCard!.options_4[currentCard!.correct_index]}"`
                : `✗ Your answer is wrong — correct answer: "${currentCard!.options_4[currentCard!.correct_index]}"`}
            </strong>
            <span>{currentCard!.deterministic_note}</span>
            <button type="button" class="btn btn-primary" onClick={handleAdvance}>
              {index + 1 >= cards.length ? "See Summary" : "Next Card"}
            </button>
          </div>
        )}

        <div class="row" style="justify-content: space-between; align-items: center;">
          <span class="muted" style="font-size: 0.8125rem;">
            Source: {currentCard!.source_name} ({currentCard!.license_id})
          </span>
          <FlagButton itemId={currentCard!.item_id} onFlaggedLocally={handleFlagLocally} />
        </div>
      </div>
    </section>
  );
}
