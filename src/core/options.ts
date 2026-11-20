import type { TrackMasteryCounts } from "./mastery.ts";
import { readPrefStorage, writePrefStorage } from "./storage.ts";
import type {
  GameDifficulty,
  GameOptions,
  HubCategoryId,
  LanguageSubtrackId,
  RomajiDisplayMode,
  SessionLength,
  TrackKey,
  UserPreferencesV1,
} from "./types.ts";

export interface TrackBadgeMeta {
  badge: string;
  accentLabel: string;
  modeHint: string;
}

export const LANGUAGE_SUBTRACK_IDS: readonly LanguageSubtrackId[] = [
  "phrases-en-ko",
  "phrases-ko-en",
  "phrases-en-ja",
  "phrases-ja-en",
];

export const ACTIVE_DIR_SHORT: Record<LanguageSubtrackId, string> = {
  "phrases-en-ko": "EN -> KO",
  "phrases-ko-en": "KO -> EN",
  "phrases-en-ja": "EN -> JA",
  "phrases-ja-en": "JA -> EN",
};

export interface LanguageDirectionMeta {
  subtrackId: LanguageSubtrackId;
  shortLabel: string;
  label: string;
  pairGroup: "ko" | "ja";
  pairTitle: string;
  hint: string;
}

export const LANGUAGE_DIRECTIONS: readonly LanguageDirectionMeta[] = [
  {
    subtrackId: "phrases-en-ko",
    shortLabel: ACTIVE_DIR_SHORT["phrases-en-ko"],
    label: "English -> Korean",
    pairGroup: "ko",
    pairTitle: "Korean",
    hint: "English prompt -> Korean choices",
  },
  {
    subtrackId: "phrases-ko-en",
    shortLabel: ACTIVE_DIR_SHORT["phrases-ko-en"],
    label: "Korean -> English",
    pairGroup: "ko",
    pairTitle: "Korean",
    hint: "Korean prompt + Romanization",
  },
  {
    subtrackId: "phrases-en-ja",
    shortLabel: ACTIVE_DIR_SHORT["phrases-en-ja"],
    label: "English -> Japanese",
    pairGroup: "ja",
    pairTitle: "Japanese",
    hint: "English prompt -> Japanese choices",
  },
  {
    subtrackId: "phrases-ja-en",
    shortLabel: ACTIVE_DIR_SHORT["phrases-ja-en"],
    label: "Japanese -> English",
    pairGroup: "ja",
    pairTitle: "Japanese",
    hint: "Japanese prompt + Romaji",
  },
];

export interface HubCategoryMeta {
  id: HubCategoryId;
  badge: string;
  accentLabel: string;
  label: string;
  description: string;
}

export const HUB_CATEGORIES: readonly HubCategoryMeta[] = [
  {
    id: "languages",
    badge: "한/あ",
    accentLabel: "LANGUAGES",
    label: "Languages (KO & JA)",
    description: "Practical Korean & Japanese phrases with optional Romanization.",
  },
  {
    id: "trivia-anime",
    badge: "★",
    accentLabel: "ANIME",
    label: "Anime Trivia",
    description: "Japanese anime & manga trivia — studios, premieres, titles, and classic lore.",
  },
  {
    id: "trivia-anime-characters",
    badge: "顔",
    accentLabel: "CHAR",
    label: "Who's That Anime?",
    description: "Story roles, powers, rivals, antagonists, and defining anime moments.",
  },
  {
    id: "trivia-world",
    badge: "◎",
    accentLabel: "WORLD",
    label: "World, Culture & Science Trivia",
    description: "General knowledge, geography, science, arts, and culture trivia.",
  },
];

export const TRACK_BADGE_META: Record<string, TrackBadgeMeta> = {
  "phrases-en-ko": { badge: "한글", accentLabel: "EN -> KO", modeHint: "English prompt -> Korean choices" },
  "phrases-ko-en": { badge: "가/나", accentLabel: "KO -> EN", modeHint: "Korean prompt + Romanization" },
  "phrases-en-ja": { badge: "かな", accentLabel: "EN -> JA", modeHint: "English prompt -> Japanese choices" },
  "phrases-ja-en": { badge: "あ/漢", accentLabel: "JA -> EN", modeHint: "Japanese prompt + Romaji" },
  "trivia-anime": { badge: "★", accentLabel: "ANIME", modeHint: "Studios, premieres & lore" },
  "trivia-anime-characters": {
    badge: "顔",
    accentLabel: "CHAR",
    modeHint: "Guess iconic characters from story & power clues",
  },
  "trivia-world": { badge: "◎", accentLabel: "WORLD", modeHint: "Culture, science & geography" },
};

export const PRB005_PREFS_STORAGE_KEY = "prb005_user_prefs_v1";

export const DEFAULT_USER_PREFS: UserPreferencesV1 = {
  schema_version: 1,
  selectedCategory: "languages",
  languageSubtrack: "phrases-en-ko",
  difficulty: "standard",
  sessionLength: 5,
  romajiMode: "subtle",
  shuffleCardsAndChoices: false,
};

export function isLanguageTrack(subtrackId: string): boolean {
  return subtrackId.startsWith("phrases-");
}

export function categoryFromSubtrack(subtrackId: string): HubCategoryId {
  if (isLanguageTrack(subtrackId)) return "languages";
  if (subtrackId === "trivia-anime") return "trivia-anime";
  if (subtrackId === "trivia-anime-characters") return "trivia-anime-characters";
  if (subtrackId === "trivia-world") return "trivia-world";
  return "languages";
}

export function resolveSubtrackId(
  category: HubCategoryId,
  languageSubtrack: LanguageSubtrackId
): TrackKey {
  if (category === "languages") {
    return (LANGUAGE_SUBTRACK_IDS as readonly string[]).includes(languageSubtrack)
      ? languageSubtrack
      : "phrases-en-ko";
  }
  return category;
}

export function aggregateLanguageTracks(
  byTrack: Record<string, TrackMasteryCounts>
): TrackMasteryCounts {
  const agg: TrackMasteryCounts = {
    learned: 0,
    learning: 0,
    familiar: 0,
    mastered: 0,
    due: 0,
  };
  for (const id of LANGUAGE_SUBTRACK_IDS) {
    const b = byTrack[id];
    if (!b) continue;
    agg.learned += b.learned;
    agg.learning += b.learning;
    agg.familiar += b.familiar;
    agg.mastered += b.mastered;
    agg.due += b.due;
  }
  return agg;
}

function normalizeCategory(v: unknown): HubCategoryId {
  if (
    v === "languages" ||
    v === "trivia-anime" ||
    v === "trivia-anime-characters" ||
    v === "trivia-world"
  ) {
    return v;
  }
  return DEFAULT_USER_PREFS.selectedCategory;
}

function normalizeLanguageSubtrack(v: unknown): LanguageSubtrackId {
  if (typeof v === "string" && (LANGUAGE_SUBTRACK_IDS as readonly string[]).includes(v)) {
    return v as LanguageSubtrackId;
  }
  return DEFAULT_USER_PREFS.languageSubtrack;
}

export function loadUserPreferences(): UserPreferencesV1 {
  const raw = readPrefStorage(PRB005_PREFS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_USER_PREFS };
  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferencesV1>;
    if (!parsed || typeof parsed !== "object" || parsed.schema_version !== 1) {
      return { ...DEFAULT_USER_PREFS };
    }
    return {
      schema_version: 1,
      selectedCategory: normalizeCategory(parsed.selectedCategory),
      languageSubtrack: normalizeLanguageSubtrack(parsed.languageSubtrack),
      difficulty: normalizeDifficulty(parsed.difficulty),
      sessionLength: normalizeSessionLength(parsed.sessionLength),
      romajiMode: normalizeRomajiMode(parsed.romajiMode),
      shuffleCardsAndChoices:
        typeof parsed.shuffleCardsAndChoices === "boolean"
          ? parsed.shuffleCardsAndChoices
          : DEFAULT_USER_PREFS.shuffleCardsAndChoices,
    };
  } catch {
    return { ...DEFAULT_USER_PREFS };
  }
}

export function saveUserPreferences(
  patch: Partial<Omit<UserPreferencesV1, "schema_version">>
): UserPreferencesV1 {
  const current = loadUserPreferences();
  const next: UserPreferencesV1 = {
    schema_version: 1,
    selectedCategory:
      patch.selectedCategory !== undefined
        ? normalizeCategory(patch.selectedCategory)
        : current.selectedCategory,
    languageSubtrack:
      patch.languageSubtrack !== undefined
        ? normalizeLanguageSubtrack(patch.languageSubtrack)
        : current.languageSubtrack,
    difficulty:
      patch.difficulty !== undefined ? normalizeDifficulty(patch.difficulty) : current.difficulty,
    sessionLength:
      patch.sessionLength !== undefined
        ? normalizeSessionLength(patch.sessionLength)
        : current.sessionLength,
    romajiMode:
      patch.romajiMode !== undefined ? normalizeRomajiMode(patch.romajiMode) : current.romajiMode,
    shuffleCardsAndChoices:
      typeof patch.shuffleCardsAndChoices === "boolean"
        ? patch.shuffleCardsAndChoices
        : current.shuffleCardsAndChoices,
  };
  writePrefStorage(PRB005_PREFS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function optionsFromPreferences(
  prefs: Pick<
    UserPreferencesV1,
    "difficulty" | "sessionLength" | "romajiMode" | "shuffleCardsAndChoices"
  >,
  subtrackId?: string,
  mode: "daily" | "practice" | "room" = "practice"
): GameOptions {
  const shuffle = subtrackId
    ? resolveTrackShuffle(subtrackId, prefs.shuffleCardsAndChoices)
    : Boolean(prefs.shuffleCardsAndChoices);
  return {
    difficulty: normalizeDifficulty(prefs.difficulty),
    shuffleCardsAndChoices: shuffle,
    romajiMode:
      subtrackId && !isLanguageTrack(subtrackId)
        ? "subtle"
        : normalizeRomajiMode(prefs.romajiMode),
    sessionLength: mode === "daily" ? 5 : normalizeSessionLength(prefs.sessionLength),
  };
}

export function shouldDefaultShuffle(subtrackId: string, mode: "daily" | "practice" | "room"): boolean {
  return mode !== "daily" || subtrackId === "trivia-anime-characters";
}

export function resolveTrackShuffle(subtrackId: string, requestedShuffle: boolean): boolean {
  return subtrackId === "trivia-anime-characters" ? true : requestedShuffle;
}

export function getDefaultGameOptions(
  subtrackId: string,
  mode: "daily" | "practice" | "room" = "daily"
): GameOptions {
  return {
    difficulty: "standard",
    shuffleCardsAndChoices: shouldDefaultShuffle(subtrackId, mode),
    romajiMode: "subtle",
    sessionLength: 5,
  };
}

export function normalizeSessionLength(n: number | null | undefined): SessionLength {
  if (n === 10 || n === 15) return n;
  return 5;
}

export function normalizeDifficulty(v: string | null | undefined): GameDifficulty {
  return v === "harder" ? "harder" : "standard";
}

export function normalizeRomajiMode(v: string | null | undefined): RomajiDisplayMode {
  if (v === "after_answer" || v === "off") return v;
  return "subtle";
}

export function extractCarriedPracticeLength(search: string): SessionLength {
  const params = new URLSearchParams(search);
  if (params.has("len")) {
    return normalizeSessionLength(Number(params.get("len")));
  }
  return loadUserPreferences().sessionLength;
}

export function buildSoloPlayUrl(
  mode: "daily" | "practice",
  trackId: string,
  opts: GameOptions
): string {
  const params = new URLSearchParams();
  params.set("track", trackId);
  if (opts.difficulty !== "standard") params.set("diff", opts.difficulty);
  if (isLanguageTrack(trackId) && opts.romajiMode !== "subtle") params.set("rom", opts.romajiMode);
  if (opts.sessionLength !== 5) params.set("len", String(opts.sessionLength));
  params.set("shuf", resolveTrackShuffle(trackId, opts.shuffleCardsAndChoices) ? "1" : "0");
  return `/play/${mode}?${params.toString()}`;
}

export function parseSoloOptionsFromSearch(
  search: string,
  trackId: string,
  mode: "daily" | "practice"
): GameOptions {
  const params = new URLSearchParams(search);
  const prefs = loadUserPreferences();
  const diff = params.has("diff") ? normalizeDifficulty(params.get("diff")) : prefs.difficulty;
  const rom: RomajiDisplayMode = isLanguageTrack(trackId)
    ? params.has("rom")
      ? normalizeRomajiMode(params.get("rom"))
      : prefs.romajiMode
    : "subtle";
  const rawShuffle = params.has("shuf")
    ? params.get("shuf") !== "0"
    : prefs.shuffleCardsAndChoices;
  const shuf = resolveTrackShuffle(trackId, rawShuffle);
  const len =
    mode === "practice"
      ? params.has("len")
        ? normalizeSessionLength(Number(params.get("len")))
        : prefs.sessionLength
      : 5;

  return {
    difficulty: diff,
    shuffleCardsAndChoices: shuf,
    romajiMode: rom,
    sessionLength: len,
  };
}
