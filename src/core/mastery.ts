import { cryptoRandomFloat } from "./entropy.ts";
import type {
  ContentShardItem,
  GameDifficulty,
  LocalActiveDay,
  LocalMasteryItem,
  MasteryTier,
} from "./types.ts";

export const TIER_ORDER: Record<MasteryTier, number> = {
  New: 0,
  Learning: 1,
  Familiar: 2,
  Mastered: 3,
};

export function getLocalDateIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getUtcDateIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Deterministic spaced-repetition scheduler (BR-01 & BR-02).
 * Intervals: 1d -> 3d -> 7d -> 21d.
 * Missed cards step back at most one tier and reschedule immediately without
 * zeroing total learned/mastered metrics.
 */
export function scheduleNextMastery(
  prev: LocalMasteryItem | undefined,
  itemId: string,
  subtrackId: string,
  isCorrect: boolean,
  todayLocalIso: string,
  nowIso = new Date().toISOString()
): LocalMasteryItem {
  const currentTier: MasteryTier = prev?.tier ?? "New";
  const prevStreak = prev?.streak_count ?? 0;

  if (isCorrect) {
    let nextTier: MasteryTier = "Learning";
    let intervalDays = 1;
    if (currentTier === "New") {
      nextTier = "Learning";
      intervalDays = 1;
    } else if (currentTier === "Learning") {
      nextTier = "Familiar";
      intervalDays = 3;
    } else if (currentTier === "Familiar") {
      nextTier = "Mastered";
      intervalDays = 7;
    } else {
      nextTier = "Mastered";
      intervalDays = 21;
    }

    return {
      item_id: itemId,
      subtrack_id: subtrackId,
      tier: nextTier,
      streak_count: prevStreak + 1,
      next_due_date: addDaysIso(todayLocalIso, intervalDays),
      updated_at: nowIso,
      flagged_hidden: prev?.flagged_hidden ?? false,
    };
  }

  // Incorrect answer: step back one tier without wiping overall progress
  let nextTier: MasteryTier = "Learning";
  if (currentTier === "Mastered") nextTier = "Familiar";
  else if (currentTier === "Familiar") nextTier = "Learning";
  else nextTier = "Learning";

  return {
    item_id: itemId,
    subtrack_id: subtrackId,
    tier: nextTier,
    streak_count: 0,
    next_due_date: todayLocalIso, // Due sooner (today)
    updated_at: nowIso,
    flagged_hidden: prev?.flagged_hidden ?? false,
  };
}

export interface DayActivityPoint {
  date: string;
  label: string;
  cards: number;
  correct: number;
  attempts: number;
}

export interface TrackMasteryCounts {
  learned: number;
  learning: number;
  familiar: number;
  mastered: number;
  due: number;
}

export interface MomentumStats {
  activeLast7Days: number;
  totalActiveDays: number;
  learnedCount: number;
  masteredCount: number;
  dueReviewCount: number;
  recentAccuracyPct: number | null;
  todayCompleted: boolean;
  days7: DayActivityPoint[];
  byTrack: Record<string, TrackMasteryCounts>;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Non-punitive rolling momentum summary (REQ-001).
 * Never resets lifetime active days or learned counts when days are missed.
 */
export function computeMomentumStats(
  activeDays: LocalActiveDay[],
  masteryItems: LocalMasteryItem[],
  todayLocalIso: string
): MomentumStats {
  const cutoff7 = addDaysIso(todayLocalIso, -6);
  let activeLast7Days = 0;
  let todayCompleted = false;
  let totalAttempts7 = 0;
  let totalCorrect7 = 0;
  const dayByIso = new Map<string, LocalActiveDay>();

  for (const day of activeDays) {
    dayByIso.set(day.local_date, day);
    if (day.cards_completed > 0) {
      if (day.local_date >= cutoff7 && day.local_date <= todayLocalIso) {
        activeLast7Days++;
        totalAttempts7 += day.attempt_count ?? 0;
        totalCorrect7 += day.correct_count ?? 0;
      }
      if (day.local_date === todayLocalIso && day.daily_grid_summary) {
        todayCompleted = true;
      }
    }
  }

  const days7: DayActivityPoint[] = [];
  for (let offset = -6; offset <= 0; offset++) {
    const iso = addDaysIso(todayLocalIso, offset);
    const [y, m, d] = iso.split("-").map(Number);
    const wd = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay();
    const rec = dayByIso.get(iso);
    days7.push({
      date: iso,
      label: offset === 0 ? "Today" : WEEKDAY_SHORT[wd] ?? iso.slice(5),
      cards: rec?.cards_completed ?? 0,
      correct: rec?.correct_count ?? 0,
      attempts: rec?.attempt_count ?? 0,
    });
  }

  let learnedCount = 0;
  let masteredCount = 0;
  let dueReviewCount = 0;
  const byTrack: Record<string, TrackMasteryCounts> = {};

  for (const item of masteryItems) {
    if (item.flagged_hidden) continue;
    let bucket = byTrack[item.subtrack_id];
    if (!bucket) {
      bucket = { learned: 0, learning: 0, familiar: 0, mastered: 0, due: 0 };
      byTrack[item.subtrack_id] = bucket;
    }
    if (item.tier !== "New") {
      learnedCount++;
      bucket.learned++;
    }
    if (item.tier === "Learning") bucket.learning++;
    else if (item.tier === "Familiar") bucket.familiar++;
    else if (item.tier === "Mastered") {
      masteredCount++;
      bucket.mastered++;
    }
    if (item.next_due_date <= todayLocalIso) {
      dueReviewCount++;
      bucket.due++;
    }
  }

  return {
    activeLast7Days,
    totalActiveDays: activeDays.filter((d) => d.cards_completed > 0).length,
    learnedCount,
    masteredCount,
    dueReviewCount,
    recentAccuracyPct:
      totalAttempts7 > 0 ? Math.round((totalCorrect7 / totalAttempts7) * 100) : null,
    todayCompleted,
    days7,
    byTrack,
  };
}

function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededPrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic fallback daily 5-card selector when offline beyond pre-built
 * static daily manifests (REQ-NFR-002).
 */
export function selectDeterministicDailyCards(
  items: ContentShardItem[],
  utcDateIso: string,
  subtrackId: string,
  hiddenIds: Set<string>
): ContentShardItem[] {
  const eligible = items.filter((it) => !hiddenIds.has(it.item_id));
  const pool = eligible.length >= 5 ? eligible : items;
  if (pool.length <= 5) return pool.slice(0, 5);

  const rng = seededPrng(hashSeed(`daily:${utcDateIso}:${subtrackId}`));
  const picked: ContentShardItem[] = [];
  const used = new Set<number>();
  while (picked.length < 5 && used.size < pool.length) {
    const idx = Math.floor(rng() * pool.length);
    if (!used.has(idx)) {
      used.add(idx);
      picked.push(pool[idx]!);
    }
  }
  return picked;
}

function shuffleArray<T>(arr: readonly T[], rng: () => number = cryptoRandomFloat): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Shuffles a card's 4 options & keeps optional romanizations and correct_index synced by value.
 * Prevents button-position memorization across sessions.
 */
export function shuffleCardChoices(
  item: ContentShardItem,
  rng: () => number = cryptoRandomFloat
): ContentShardItem {
  const originalAnswer = item.options_4[item.correct_index];
  const perm = shuffleArray([0, 1, 2, 3], rng);
  const nextOptions = perm.map((idx) => item.options_4[idx]!) as [string, string, string, string];
  const nextRomanization =
    item.options_romanization && item.options_romanization.length === 4
      ? (perm.map((idx) => item.options_romanization![idx]!) as [string, string, string, string])
      : undefined;
  const nextCorrectIndex = nextOptions.indexOf(originalAnswer!) as 0 | 1 | 2 | 3;
  if (nextCorrectIndex < 0 || nextCorrectIndex > 3) {
    throw new Error(`shuffleCardChoices invariant failed for ${item.item_id}`);
  }

  return {
    ...item,
    options_4: nextOptions,
    ...(nextRomanization ? { options_romanization: nextRomanization } : {}),
    correct_index: nextCorrectIndex,
  };
}

/**
 * Applies session-level shuffling to card order and/or choices cleanly.
 */
export function applySessionCardOrderAndChoices(
  items: ContentShardItem[],
  shuffleEnabled: boolean,
  rng: () => number = cryptoRandomFloat
): ContentShardItem[] {
  const ordered = shuffleEnabled ? shuffleArray(items, rng) : [...items];
  return shuffleEnabled ? ordered.map((it) => shuffleCardChoices(it, rng)) : ordered;
}

/**
 * Practice card selector: prioritizes due review items first, then unseen items,
 * then general practice items (zero energy lockout), stratifying by difficulty sub-tier
 * in Harder mode before slicing top `count` and randomizing final presentation order & choices.
 */
export function selectPracticeCards(
  items: ContentShardItem[],
  masteryMap: Map<string, LocalMasteryItem>,
  todayLocalIso: string,
  count = 5,
  difficulty: GameDifficulty = "standard",
  shuffle = true,
  rng: () => number = cryptoRandomFloat
): ContentShardItem[] {
  const visible = items.filter((it) => !masteryMap.get(it.item_id)?.flagged_hidden);
  const due: ContentShardItem[] = [];
  const unseen: ContentShardItem[] = [];
  const rest: ContentShardItem[] = [];

  for (const it of visible) {
    const m = masteryMap.get(it.item_id);
    if (!m || m.tier === "New") unseen.push(it);
    else if (m.next_due_date <= todayLocalIso) due.push(it);
    else rest.push(it);
  }

  const stratifyBucket = (bucket: ContentShardItem[]) => {
    if (difficulty !== "harder") {
      return shuffle ? shuffleArray(bucket, rng) : [...bucket];
    }
    const challenges = bucket.filter((it) => it.difficulty === "challenge");
    const intermediates = bucket.filter((it) => it.difficulty === "intermediate");
    const beginners = bucket.filter((it) => it.difficulty === "beginner");
    return shuffle
      ? [
          ...shuffleArray(challenges, rng),
          ...shuffleArray(intermediates, rng),
          ...shuffleArray(beginners, rng),
        ]
      : [...challenges, ...intermediates, ...beginners];
  };

  const picked = [...stratifyBucket(due), ...stratifyBucket(unseen), ...stratifyBucket(rest)].slice(
    0,
    count
  );
  if (!shuffle) return picked;
  return shuffleArray(picked, rng).map((it) => shuffleCardChoices(it, rng));
}
