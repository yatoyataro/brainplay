import { useState } from "preact/hooks";
import {
  createBackupPayload,
  encodeSyncString,
  mergeMasteryState,
  parseAndVerifyBackup,
} from "../core/backup.ts";
import type { MomentumStats } from "../core/mastery.ts";
import {
  ACTIVE_DIR_SHORT,
  aggregateLanguageTracks,
  buildSoloPlayUrl,
  isLanguageTrack,
  LANGUAGE_DIRECTIONS,
  LANGUAGE_SUBTRACK_IDS,
  loadUserPreferences,
  optionsFromPreferences,
  TRACK_BADGE_META,
} from "../core/options.ts";
import type { StorageBackendMode } from "../core/storage.ts";
import type {
  LocalActiveDay,
  LocalMasteryItem,
  PackCatalog,
  UserPreferencesV1,
} from "../core/types.ts";

interface MasteryViewProps {
  storageMode: StorageBackendMode;
  storageWarning?: string | null;
  onDismissStorageWarning?: () => void;
  catalog: PackCatalog | null;
  masteryItems: LocalMasteryItem[];
  activeDays: LocalActiveDay[];
  momentum: MomentumStats;
  prefs?: UserPreferencesV1;
  onReplaceAll: (mastery: LocalMasteryItem[], activeDays: LocalActiveDay[]) => Promise<void>;
  onNavigate: (path: string) => void;
}

const EMPTY_COUNTS = { learned: 0, learning: 0, familiar: 0, mastered: 0, due: 0 };

export function MasteryView({
  storageMode,
  storageWarning,
  onDismissStorageWarning,
  catalog,
  masteryItems,
  activeDays,
  momentum,
  prefs,
  onReplaceAll,
  onNavigate,
}: MasteryViewProps) {
  const [syncText, setSyncText] = useState("");
  const [importInput, setImportInput] = useState("");
  const [importStatus, setImportStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const activePrefs = prefs ?? loadUserPreferences();
  const practiceUrlFor = (targetTrack: string) =>
    buildSoloPlayUrl(
      "practice",
      targetTrack,
      optionsFromPreferences(activePrefs, targetTrack, "practice")
    );

  const visible = masteryItems.filter((m) => !m.flagged_hidden);
  const counts = {
    Learning: visible.filter((m) => m.tier === "Learning").length,
    Familiar: visible.filter((m) => m.tier === "Familiar").length,
    Mastered: visible.filter((m) => m.tier === "Mastered").length,
  };
  const hiddenCount = masteryItems.filter((m) => m.flagged_hidden).length;

  // Pick the track with the highest due review cards (> 0) for the 1-tap Review CTA
  let mostDueTrack = catalog?.tracks[0]?.subtrack_id ?? "phrases-en-ko";
  let highestDue = 0;
  for (const [subId, stats] of Object.entries(momentum.byTrack)) {
    if (stats.due > 0 && stats.due > highestDue) {
      highestDue = stats.due;
      mostDueTrack = subId;
    }
  }
  const mostDueLabel =
    catalog?.tracks.find((t) => t.subtrack_id === mostDueTrack)?.label ?? mostDueTrack;

  const langTracks = (catalog?.tracks ?? []).filter((t) => isLanguageTrack(t.subtrack_id));
  const langTotalItems = langTracks.reduce((sum, t) => sum + t.item_count, 0);
  const langAgg = aggregateLanguageTracks(momentum.byTrack);
  const langDenom = Math.max(1, langAgg.learned);

  let groupTargetLang: string = activePrefs.languageSubtrack;
  let maxLangDue = 0;
  for (const dirId of LANGUAGE_SUBTRACK_IDS) {
    const due = momentum.byTrack[dirId]?.due ?? 0;
    if (due > maxLangDue) {
      maxLangDue = due;
      groupTargetLang = dirId;
    }
  }

  const triviaTracks = (catalog?.tracks ?? []).filter((t) => !isLanguageTrack(t.subtrack_id));
  const maxWeekCards = Math.max(5, ...momentum.days7.map((d) => d.cards));

  const handleGenerateSync = () => {
    setSyncText(encodeSyncString(masteryItems, activeDays));
  };

  const handleDownloadJson = () => {
    const payload = createBackupPayload(masteryItems, activeDays);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `brainplay-mastery-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async () => {
    const parsed = parseAndVerifyBackup(importInput);
    if (!parsed.ok) {
      setImportStatus({ ok: false, msg: parsed.error });
      return;
    }
    const merged = mergeMasteryState(
      masteryItems,
      parsed.payload.mastery,
      activeDays,
      parsed.payload.active_days
    );
    try {
      await onReplaceAll(merged.mastery, merged.activeDays);
      setImportInput("");
      setImportStatus({
        ok: true,
        msg: `Merged ${parsed.payload.mastery.length} mastery cards safely via max(tier) resolution.`,
      });
    } catch (err) {
      setImportStatus({
        ok: false,
        msg:
          err instanceof Error
            ? `Failed to save imported backup: ${err.message}`
            : "Failed to save imported backup locally.",
      });
    }
  };

  const handleUnhideAll = async () => {
    const restored = masteryItems.map((m) => ({ ...m, flagged_hidden: false }));
    try {
      await onReplaceAll(restored, activeDays);
    } catch {
      // Storage warning banner reports persistence fallback cleanly
    }
  };

  return (
    <div class="stack">
      {(storageWarning || storageMode !== "indexeddb") && (
        <div
          class="banner banner-warn row"
          style="justify-content: space-between;"
          role="status"
          data-testid="storage-warning-banner"
        >
          <span>
            {storageWarning ??
              `Private/ephemeral storage mode (${storageMode}): export a backup before closing this browser tab.`}
          </span>
          {storageWarning && onDismissStorageWarning && (
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

      <div class="bento-grid">
        <div class="bento-primary">
          <section class="card stack" aria-labelledby="mastery-title">
            <div class="row" style="justify-content: space-between; align-items: flex-start;">
              <div class="stack" style="gap: 4px; flex: 1 1 220px; min-width: 0;">
                <h1 id="mastery-title" class="h1">
                  My Mastery Dashboard
                </h1>
                <p class="muted">
                  Streak-free, guilt-free progress stored 100% locally in IndexedDB ($0 server cost).
                </p>
              </div>
              <div class="mastery-cta-wrap">
                <button
                  type="button"
                  class="btn btn-primary"
                  data-testid="review-due-cta"
                  onClick={() => onNavigate(practiceUrlFor(mostDueTrack))}
                >
                  {momentum.dueReviewCount > 0
                    ? `Review Due Cards (${momentum.dueReviewCount})`
                    : "Quick Practice Round"}
                </button>
                {momentum.dueReviewCount > 0 ? (
                  <span class="muted" style="font-size: 0.8125rem;">
                    Top due: {mostDueLabel}
                  </span>
                ) : momentum.learnedCount > 0 ? (
                  <span class="pill pill-ok" data-testid="all-caught-up-badge">
                    All caught up — no cards due
                  </span>
                ) : null}
              </div>
            </div>

            <div class="stat-trio">
              <div class="stat-tile">
                <div class="stat-num">{momentum.learnedCount}</div>
                <div class="stat-lbl">Cards Learned</div>
              </div>
              <div class="stat-tile">
                <div class="stat-num">{counts.Mastered}</div>
                <div class="stat-lbl">Mastered (7d+)</div>
              </div>
              <div class="stat-tile">
                <div class="stat-num">
                  {momentum.recentAccuracyPct !== null ? `${momentum.recentAccuracyPct}%` : "—"}
                </div>
                <div class="stat-lbl">7-Day Accuracy</div>
              </div>
              <div class="stat-tile">
                <div class="stat-num">{momentum.totalActiveDays}</div>
                <div class="stat-lbl">Total Active Days</div>
              </div>
            </div>
          </section>

          <section
            class="card stack"
            aria-labelledby="per-track-title"
            data-testid="per-track-progress"
          >
            <div class="row" style="justify-content: space-between;">
              <h2 id="per-track-title" class="h2">
                Progress by Category
              </h2>
              <div class="row" style="gap: 6px; font-size: 0.78rem;">
                <span class="pill pill-ok">Mastered {counts.Mastered}</span>
                <span class="pill">Familiar {counts.Familiar}</span>
                <span class="pill">Learning {counts.Learning}</span>
              </div>
            </div>

            <div class="legend-row" aria-label="Mastery tier color legend">
              <span class="legend-item">
                <span class="legend-dot legend-mastered" aria-hidden="true" />
                Mastered
              </span>
              <span class="legend-item">
                <span class="legend-dot legend-familiar" aria-hidden="true" />
                Familiar
              </span>
              <span class="legend-item">
                <span class="legend-dot legend-learning" aria-hidden="true" />
                Learning
              </span>
            </div>

            {!catalog ? (
              <div class="stack" aria-busy="true" data-testid="mastery-catalog-skeleton">
                <div class="skeleton skeleton-box" />
                <div class="skeleton skeleton-box" />
                <div class="skeleton skeleton-box" />
              </div>
            ) : (
              <div class="stack">
                {visible.length === 0 && (
                  <p class="muted" style="font-size: 0.875rem;">
                    No cards learned yet — pick any category below for a gentle 5-card start.
                  </p>
                )}

                {/* Unified Languages Parent Group + 4 Directions */}
                <div
                  class="card-subtle stack"
                  style="gap: 10px; padding: 12px;"
                  data-testid="mastery-languages-group"
                  aria-labelledby="mastery-lang-heading"
                >
                  <div class="row" style="justify-content: space-between;">
                    <span class="row" style="gap: 6px; min-width: 0;">
                      <span class="track-badge">LANGUAGES</span>
                      <strong id="mastery-lang-heading" data-testid="mastery-lang-heading">
                        Languages (KO &amp; JA)
                      </strong>
                    </span>
                    <div
                      class="row"
                      style="gap: 6px; font-size: 0.8125rem; font-variant-numeric: tabular-nums;"
                    >
                      <span class="muted">
                        {langAgg.mastered} Mastered · {langAgg.familiar} Familiar · {langAgg.learning} Learning
                      </span>
                      {langAgg.due > 0 && <span class="pill pill-warn">{langAgg.due} due</span>}
                    </div>
                  </div>
                  <div
                    class="stacked-bar"
                    aria-label={`Languages: ${langAgg.learned} of ${langTotalItems} cards touched`}
                  >
                    {langAgg.learned > 0 && (
                      <>
                        <div class="seg-mastered" style={`width: ${(langAgg.mastered / langDenom) * 100}%`} />
                        <div class="seg-familiar" style={`width: ${(langAgg.familiar / langDenom) * 100}%`} />
                        <div class="seg-learning" style={`width: ${(langAgg.learning / langDenom) * 100}%`} />
                      </>
                    )}
                  </div>
                  <div class="row" style="justify-content: space-between;">
                    <span class="muted" style="font-size: 0.8125rem;">
                      {langAgg.learned} / {langTotalItems} cards seen (
                      {Math.round((langAgg.learned / Math.max(1, langTotalItems)) * 100)}%)
                    </span>
                    <div class="row" style="gap: 6px;">
                      {langTotalItems > 0 && langAgg.mastered >= langTotalItems && (
                        <span class="pill pill-ok">✓ Mastered</span>
                      )}
                      <button
                        type="button"
                        class={`btn btn-sm ${langAgg.due > 0 ? "btn-primary" : "btn-secondary"}`}
                        onClick={() => onNavigate(practiceUrlFor(groupTargetLang))}
                      >
                        {langAgg.due > 0
                          ? `Review Due (${langAgg.due})`
                          : `Practice (${ACTIVE_DIR_SHORT[activePrefs.languageSubtrack]})`}
                      </button>
                    </div>
                  </div>

                  <div class="mastery-sublist">
                    {LANGUAGE_DIRECTIONS.map((dir) => {
                      const trackMeta = langTracks.find((t) => t.subtrack_id === dir.subtrackId);
                      const itemCount = trackMeta?.item_count ?? 360;
                      const st = momentum.byTrack[dir.subtrackId] ?? EMPTY_COUNTS;
                      const seenPct = Math.round((st.learned / Math.max(1, itemCount)) * 100);
                      return (
                        <div
                          key={dir.subtrackId}
                          class="mastery-subrow"
                          data-testid={`mastery-subrow-${dir.subtrackId}`}
                        >
                          <div class="stack" style="gap: 2px; min-width: 0;">
                            <span class="row" style="gap: 6px;">
                              <span class="track-badge">{dir.shortLabel}</span>
                              <strong style="font-size: 0.875rem;">{dir.label}</strong>
                            </span>
                            <span class="muted" style="font-size: 0.78rem; font-variant-numeric: tabular-nums;">
                              {st.learned} / {itemCount} cards seen ({seenPct}%) · {st.mastered} Mastered
                            </span>
                          </div>
                          <div class="row" style="gap: 6px;">
                            {itemCount > 0 && st.mastered >= itemCount && (
                              <span class="pill pill-ok">✓ Mastered</span>
                            )}
                            {st.due > 0 && <span class="pill pill-warn">{st.due} due</span>}
                            <button
                              type="button"
                              class={`btn btn-sm ${st.due > 0 ? "btn-primary" : "btn-secondary"}`}
                              onClick={() => onNavigate(practiceUrlFor(dir.subtrackId))}
                            >
                              {st.due > 0 ? `Review Due (${st.due})` : "Practice"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 3 Trivia Categories */}
                {triviaTracks.map((t) => {
                  const st = momentum.byTrack[t.subtrack_id] ?? EMPTY_COUNTS;
                  const denom = Math.max(1, st.learned);
                  const mPct = (st.mastered / denom) * 100;
                  const fPct = (st.familiar / denom) * 100;
                  const lPct = (st.learning / denom) * 100;
                  const meta = TRACK_BADGE_META[t.subtrack_id];

                  return (
                    <div key={t.subtrack_id} class="card-subtle stack" style="gap: 8px; padding: 12px;">
                      <div class="row" style="justify-content: space-between;">
                        <span class="row" style="gap: 6px; min-width: 0;">
                          {meta && <span class="track-badge">{meta.accentLabel}</span>}
                          <strong>{t.label}</strong>
                        </span>
                        <div
                          class="row"
                          style="gap: 6px; font-size: 0.8125rem; font-variant-numeric: tabular-nums;"
                        >
                          <span class="muted">
                            {st.mastered} Mastered · {st.familiar} Familiar · {st.learning} Learning
                          </span>
                          {st.due > 0 && <span class="pill pill-warn">{st.due} due</span>}
                        </div>
                      </div>
                      <div
                        class="stacked-bar"
                        aria-label={`${t.label}: ${st.learned} of ${t.item_count} cards touched`}
                      >
                        {st.learned > 0 && (
                          <>
                            <div class="seg-mastered" style={`width: ${mPct}%`} />
                            <div class="seg-familiar" style={`width: ${fPct}%`} />
                            <div class="seg-learning" style={`width: ${lPct}%`} />
                          </>
                        )}
                      </div>
                      <div class="row" style="justify-content: space-between;">
                        <span class="muted" style="font-size: 0.8125rem;">
                          {st.learned} / {t.item_count} cards seen (
                          {Math.round((st.learned / Math.max(1, t.item_count)) * 100)}%)
                        </span>
                        <div class="row" style="gap: 6px;">
                          {t.item_count > 0 && st.mastered >= t.item_count && (
                            <span class="pill pill-ok">✓ Mastered</span>
                          )}
                          <button
                            type="button"
                            class={`btn btn-sm ${st.due > 0 ? "btn-primary" : "btn-secondary"}`}
                            onClick={() => onNavigate(practiceUrlFor(t.subtrack_id))}
                          >
                            {st.due > 0 ? `Review Due (${st.due})` : "Practice"}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {hiddenCount > 0 && (
              <div class="row" style="justify-content: space-between;">
                <span class="muted">{hiddenCount} flagged cards hidden locally</span>
                <button type="button" class="btn-link" onClick={() => void handleUnhideAll()}>
                  Restore hidden cards
                </button>
              </div>
            )}
          </section>
        </div>

        <aside class="bento-companion" aria-label="Activity insights and local backup">
          <section class="card stack" aria-labelledby="activity-guide-title">
            <h2 id="activity-guide-title" class="h2">
              7-Day Activity &amp; Study Guide
            </h2>

            <div class="stack" style="gap: 6px;">
              <div class="row" style="justify-content: space-between;">
                <strong style="font-size: 0.9375rem;">7-Day Rolling Activity</strong>
                <span class="muted" style="font-size: 0.8125rem;">
                  {momentum.activeLast7Days} / 7 days active (never resets to 0)
                </span>
              </div>
              <div class="week-strip" role="list" aria-label="Last 7 days cards completed">
                {momentum.days7.map((d) => {
                  const pct = d.cards > 0 ? Math.max(18, Math.round((d.cards / maxWeekCards) * 100)) : 0;
                  return (
                    <div key={d.date} class="day-col" role="listitem">
                      <span class="muted" style="font-size: 0.72rem; font-variant-numeric: tabular-nums;">
                        {d.cards > 0 ? d.cards : "·"}
                      </span>
                      <div class="day-bar-wrap" aria-hidden="true">
                        <div class="day-bar-fill" style={`transform: scaleY(${pct / 100})`} />
                      </div>
                      <span class="day-label">{d.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <p class="muted" style="font-size: 0.875rem;">
              {momentum.recentAccuracyPct !== null
                ? `Recent 7-day accuracy: ${momentum.recentAccuracyPct}%. Due reviews surface gently when cards are ready.`
                : "Play any 5-card round to unlock 7-day accuracy insights."}
            </p>

            <div class="card-subtle stack" style="gap: 6px; padding: 12px;">
              <strong style="font-size: 0.875rem;">Guilt-Free Study Guide</strong>
              <ol
                class="muted"
                style="margin: 0; padding-left: 18px; font-size: 0.8125rem; display: grid; gap: 4px;"
              >
                <li>
                  <strong>Learning (1d) → Familiar (3d):</strong> Each recall spaces your next review smoothly.
                </li>
                <li>
                  <strong>Mastered (7d+):</strong> Consistent answers move cards to relaxed 7d–21d intervals.
                </li>
                <li>
                  <strong>Zero streak wipes:</strong> Missed cards step back 1 tier without erasing history.
                </li>
              </ol>
            </div>
          </section>

          <section class="card stack" aria-labelledby="backup-title">
            <h2 id="backup-title" class="h2">
              Portable Backup &amp; Sync ($0 Local-First)
            </h2>
            <p class="muted">
              Transfer progress across devices with zero account servers. Imports verify SHA/checksum before merging.
            </p>

            <div class="row">
              <button type="button" class="btn btn-secondary" onClick={handleGenerateSync}>
                Generate Sync Code
              </button>
              <button type="button" class="btn btn-secondary" onClick={handleDownloadJson}>
                Download JSON Backup
              </button>
            </div>

            {syncText && (
              <div class="stack">
                <label class="field-label" htmlFor="sync-code-output">
                  Copy Sync Code
                </label>
                <textarea
                  id="sync-code-output"
                  class="input"
                  rows={3}
                  readOnly
                  value={syncText}
                  onClick={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
                />
              </div>
            )}

            <div class="stack">
              <label class="field-label" htmlFor="import-backup-input">
                Restore / Merge Backup (Paste Sync Code or JSON)
              </label>
              <textarea
                id="import-backup-input"
                class="input"
                rows={3}
                placeholder="Paste BP1.... sync code or backup JSON here"
                value={importInput}
                onInput={(e) => setImportInput((e.currentTarget as HTMLTextAreaElement).value)}
              />
              <button type="button" class="btn btn-primary" onClick={() => void handleImport()}>
                Verify &amp; Merge Backup
              </button>
            </div>

            {importStatus && (
              <div class={`banner ${importStatus.ok ? "banner-ok" : "banner-err"} stack`} role="alert">
                <span>{importStatus.msg}</span>
                {!importStatus.ok && (
                  <div class="row">
                    <button
                      type="button"
                      class="btn btn-secondary btn-sm"
                      data-testid="clear-import-btn"
                      onClick={() => {
                        setImportInput("");
                        setImportStatus(null);
                      }}
                    >
                      Clear Input
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
