import { createHash } from "node:crypto";
import {
  hasHangul,
  hasJapanese,
  hasResidualHtmlArtifacts,
  normalizeForMatching,
  normalizeUtf8Text,
} from "../../../src/core/normalize.ts";
import type {
  ContentShardItem,
  DailyManifest,
  DifficultyTier,
  LicenseId,
  PackCatalog,
  ShardMeta,
  TrackGroup,
} from "../../../src/core/types.ts";
import { romanizeKorean, type JapaneseRomanizer } from "./romanize.ts";

export interface RawSentenceRow {
  id: string;
  lang: "eng" | "kor" | "jpn";
  text: string;
  author: string;
}

export interface RawLinkRow {
  sourceId: string;
  targetId: string;
}

export interface RawOpenTriviaRow {
  category: string;
  difficulty: string;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

export interface RawAniListMedia {
  id: number;
  title?: { romaji?: string | null; english?: string | null; native?: string | null };
  seasonYear?: number | null;
  format?: string | null;
  source?: string | null;
  episodes?: number | null;
  genres?: string[];
  studios?: { nodes?: Array<{ name?: string | null }> };
}

export interface RawKitsuAnime {
  id: string;
  canonicalTitle?: string | null;
  titles?: { en?: string | null; en_jp?: string | null };
  startDate?: string | null;
  subtype?: string | null;
  episodeCount?: number | null;
}

export interface RawAniListCharacter {
  id: number;
  name?: {
    full?: string | null;
    native?: string | null;
    alternative?: string[] | null;
    alternativeSpoiler?: string[] | null;
  };
  gender?: string | null;
  age?: string | null;
  favourites?: number | null;
  description?: string | null;
  media?: {
    edges?: Array<{
      characterRole?: string | null;
      voiceActors?: Array<{ name?: { full?: string | null; native?: string | null } }>;
      node?: {
        id: number;
        isAdult?: boolean | null;
        title?: { english?: string | null; romaji?: string | null };
        seasonYear?: number | null;
        format?: string | null;
        genres?: string[] | null;
        studios?: { nodes?: Array<{ name?: string | null }> };
        tags?: Array<{
          name?: string | null;
          rank?: number | null;
          isMediaSpoiler?: boolean | null;
        }>;
        relations?: {
          edges?: Array<{
            relationType?: string | null;
            node?: {
              id: number;
              title?: { english?: string | null; romaji?: string | null } | null;
            } | null;
          }>;
        };
      };
    }>;
  };
}

export interface PairSpec {
  subtrack_id: string;
  label: string;
  description: string;
  source_lang: "eng" | "kor" | "jpn";
  target_lang: "eng" | "kor" | "jpn";
  max_items: number;
}

export const DEFAULT_TRACK1_PAIRS: PairSpec[] = [
  {
    subtrack_id: "phrases-en-ko",
    label: "English -> Korean",
    description: "Practical everyday phrases translated from English to Korean.",
    source_lang: "eng",
    target_lang: "kor",
    max_items: 360,
  },
  {
    subtrack_id: "phrases-ko-en",
    label: "Korean -> English",
    description: "Read everyday Korean Hangul phrases and pick the natural English meaning.",
    source_lang: "kor",
    target_lang: "eng",
    max_items: 360,
  },
  {
    subtrack_id: "phrases-en-ja",
    label: "English -> Japanese",
    description: "Practical everyday phrases translated from English to Japanese.",
    source_lang: "eng",
    target_lang: "jpn",
    max_items: 360,
  },
  {
    subtrack_id: "phrases-ja-en",
    label: "Japanese -> English",
    description: "Read Japanese phrases in context and pick the natural English meaning.",
    source_lang: "jpn",
    target_lang: "eng",
    max_items: 360,
  },
];

export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Warm up 8 steps so low-entropy FNV-1a seeds yield balanced 0..3 option distributions
  for (let i = 0; i < 8; i++) next();
  return next;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateScript(lang: "eng" | "kor" | "jpn", text: string): boolean {
  if (lang === "kor") return hasHangul(text);
  if (lang === "jpn") return hasJapanese(text);
  return /[a-zA-Z]/.test(text);
}

function estimateDifficulty(prompt: string, answer: string): DifficultyTier {
  const combined = prompt.length + answer.length;
  if (combined <= 42) return "beginner";
  if (combined <= 85) return "intermediate";
  return "challenge";
}

function isCleanText(text: string, maxLen = 220): boolean {
  if (text.length < 2 || text.length > maxLen) return false;
  if (hasResidualHtmlArtifacts(text)) return false;
  if (/https?:\/\/|www\.|\[[^\]]{2,}\]/.test(text)) return false;
  return true;
}

export function parseSentencesTsv(
  tsvText: string,
  lang: "eng" | "kor" | "jpn"
): Map<string, RawSentenceRow> {
  const map = new Map<string, RawSentenceRow>();
  for (const line of tsvText.split(/\r?\n/)) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const id = cols[0]?.trim() ?? "";
    const rowLang = cols[1]?.trim() ?? "";
    const rawText = cols[2] ?? "";
    const author = cols[3]?.trim() && cols[3] !== "\\N" ? cols[3].trim() : "Tatoeba contributor";
    if (!id || rowLang !== lang) continue;
    const text = normalizeUtf8Text(rawText);
    if (!isCleanText(text, 140) || !validateScript(lang, text)) continue;
    map.set(id, { id, lang, text, author });
  }
  return map;
}

export function parseLinksTsv(tsvText: string): RawLinkRow[] {
  const rows: RawLinkRow[] = [];
  for (const line of tsvText.split(/\r?\n/)) {
    if (!line) continue;
    const [a, b] = line.split("\t");
    if (a && b) rows.push({ sourceId: a.trim(), targetId: b.trim() });
  }
  return rows;
}

async function romanizeForLang(
  lang: "eng" | "kor" | "jpn",
  text: string,
  jaRomanizer?: JapaneseRomanizer
): Promise<string | undefined> {
  if (lang === "kor") return romanizeKorean(text);
  if (lang === "jpn" && jaRomanizer) return await jaRomanizer.romanize(text);
  return undefined;
}

export async function buildPhraseItems(
  pair: PairSpec,
  sourceSentences: Map<string, RawSentenceRow>,
  targetSentences: Map<string, RawSentenceRow>,
  links: RawLinkRow[],
  jaRomanizer?: JapaneseRomanizer
): Promise<ContentShardItem[]> {
  const candidates: Array<{
    src: RawSentenceRow;
    tgt: RawSentenceRow;
    score: number;
  }> = [];
  const seenPrompts = new Set<string>();
  const seenTargets = new Set<string>();

  for (const link of links) {
    const src = sourceSentences.get(link.sourceId) ?? sourceSentences.get(link.targetId);
    const tgt = targetSentences.get(link.targetId) ?? targetSentences.get(link.sourceId);
    if (!src || !tgt) continue;
    if (src.lang !== pair.source_lang || tgt.lang !== pair.target_lang) continue;
    if (src.text.length < 4 || src.text.length > 90) continue;
    if (tgt.text.length < 2 || tgt.text.length > 90) continue;

    const pNorm = normalizeForMatching(src.text);
    const tNorm = normalizeForMatching(tgt.text);
    if (!pNorm || !tNorm || pNorm === tNorm) continue;
    if (seenPrompts.has(pNorm) || seenTargets.has(tNorm)) continue;

    seenPrompts.add(pNorm);
    seenTargets.add(tNorm);

    const lengthPenalty = Math.abs(src.text.length - 26) + Math.abs(tgt.text.length - 20);
    candidates.push({ src, tgt, score: lengthPenalty });
  }

  candidates.sort((a, b) => a.score - b.score || a.src.id.localeCompare(b.src.id));
  const selected = candidates.slice(0, pair.max_items);

  const targetPool = selected.map((c) => c.tgt.text);
  const items: ContentShardItem[] = [];

  // Cache romanizations by text to speed up distractor reuse
  const romCache = new Map<string, string>();
  const getRom = async (lang: "eng" | "kor" | "jpn", text: string): Promise<string | undefined> => {
    if (lang === "eng") return undefined;
    const key = `${lang}:${text}`;
    const hit = romCache.get(key);
    if (hit !== undefined) return hit;
    const res = await romanizeForLang(lang, text, jaRomanizer);
    if (res) romCache.set(key, res);
    return res;
  };

  for (let i = 0; i < selected.length; i++) {
    const entry = selected[i]!;
    const rng = mulberry32(fnv1a32(`${pair.subtrack_id}:${entry.src.id}:${entry.tgt.id}`));
    const correctNorm = normalizeForMatching(entry.tgt.text);

    const desiredMin = Math.max(2, Math.floor(entry.tgt.text.length * 0.55));
    const desiredMax = Math.ceil(entry.tgt.text.length * 1.55);
    const nearPool = targetPool.filter(
      (t) =>
        t.length >= desiredMin &&
        t.length <= desiredMax &&
        normalizeForMatching(t) !== correctNorm
    );
    const fallbackPool = targetPool.filter((t) => normalizeForMatching(t) !== correctNorm);

    const distractors: string[] = [];
    const usedNorms = new Set<string>([correctNorm]);

    const tryPickFrom = (pool: string[], maxSteps: number) => {
      if (pool.length === 0) return;
      for (let step = 0; step < maxSteps && distractors.length < 3; step++) {
        const pick = pool[Math.floor(rng() * pool.length)]!;
        const norm = normalizeForMatching(pick);
        if (!usedNorms.has(norm)) {
          usedNorms.add(norm);
          distractors.push(pick);
        }
      }
    };

    tryPickFrom(nearPool, 40);
    if (distractors.length < 3) tryPickFrom(fallbackPool, 80);
    if (distractors.length < 3) continue;

    const options: [string, string, string, string] = [
      entry.tgt.text,
      distractors[0]!,
      distractors[1]!,
      distractors[2]!,
    ];
    for (let k = 3; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      const tmp = options[k]!;
      options[k] = options[j]!;
      options[j] = tmp;
    }
    const correctIndex = options.indexOf(entry.tgt.text) as 0 | 1 | 2 | 3;
    const difficulty = estimateDifficulty(entry.src.text, entry.tgt.text);

    const promptRom = await getRom(pair.source_lang, entry.src.text);
    let optionsRom: [string, string, string, string] | undefined;
    if (pair.target_lang !== "eng") {
      const r0 = (await getRom(pair.target_lang, options[0])) ?? "";
      const r1 = (await getRom(pair.target_lang, options[1])) ?? "";
      const r2 = (await getRom(pair.target_lang, options[2])) ?? "";
      const r3 = (await getRom(pair.target_lang, options[3])) ?? "";
      if (r0 && r1 && r2 && r3) optionsRom = [r0, r1, r2, r3];
    }

    const answerRomNote = optionsRom ? ` (${optionsRom[correctIndex]})` : "";

    items.push({
      item_id: `tat-${pair.subtrack_id.replace("phrases-", "")}-${entry.src.id}`,
      track_id: "phrases",
      subtrack_id: pair.subtrack_id,
      difficulty,
      prompt: entry.src.text,
      ...(promptRom ? { prompt_romanization: promptRom } : {}),
      options_4: options,
      ...(optionsRom ? { options_romanization: optionsRom } : {}),
      correct_index: correctIndex,
      deterministic_note: `${pair.label} (${difficulty}). Answer: "${entry.tgt.text}"${answerRomNote}. Source: Tatoeba #${entry.src.id} by ${entry.src.author} (CC BY 2.0 FR).`,
      source_name: "Tatoeba",
      source_author: `${entry.src.author} / ${entry.tgt.author}`,
      license_id: "CC-BY-2.0-FR",
    });
  }

  return items;
}

function decodeOpenTriviaField(raw: string): string {
  try {
    return normalizeUtf8Text(decodeURIComponent(raw));
  } catch {
    return normalizeUtf8Text(raw);
  }
}

export function buildTriviaItems(
  rawRows: RawOpenTriviaRow[],
  subtrackId: "trivia-world" | "trivia-anime" = "trivia-world",
  excludePrompts?: Set<string>
): ContentShardItem[] {
  const seenPrompts = new Set<string>(excludePrompts ?? []);
  const items: ContentShardItem[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i]!;
    const prompt = decodeOpenTriviaField(row.question);
    const category = decodeOpenTriviaField(row.category);
    const correct = decodeOpenTriviaField(row.correct_answer);
    const incorrect = row.incorrect_answers.map(decodeOpenTriviaField);

    if (!isCleanText(prompt, 220)) continue;
    if (!isCleanText(correct, 140)) continue;
    if (incorrect.length !== 3 || incorrect.some((opt) => !isCleanText(opt, 140))) continue;

    const promptNorm = normalizeForMatching(prompt);
    if (seenPrompts.has(promptNorm)) continue;

    const allOptions = [correct, ...incorrect];
    const optionNorms = new Set(allOptions.map(normalizeForMatching));
    if (optionNorms.size !== 4) continue;

    seenPrompts.add(promptNorm);

    const rng = mulberry32(fnv1a32(`opentdb:${subtrackId}:${promptNorm}`));
    const shuffled = [...allOptions] as [string, string, string, string];
    for (let k = 3; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      const tmp = shuffled[k]!;
      shuffled[k] = shuffled[j]!;
      shuffled[j] = tmp;
    }
    const correctIndex = shuffled.indexOf(correct) as 0 | 1 | 2 | 3;

    const diffRaw = row.difficulty?.toLowerCase();
    const difficulty: DifficultyTier =
      diffRaw === "easy" ? "beginner" : diffRaw === "hard" ? "challenge" : "intermediate";

    items.push({
      item_id: `otdb-${subtrackId === "trivia-anime" ? "an-" : ""}${fnv1a32(promptNorm)
        .toString(16)
        .padStart(8, "0")}`,
      track_id: "trivia",
      subtrack_id: subtrackId,
      difficulty,
      prompt,
      options_4: shuffled,
      correct_index: correctIndex,
      deterministic_note: `${category} (${difficulty}). Verified answer: "${correct}". Source: OpenTriviaDB (CC BY-SA 4.0).`,
      source_name: "OpenTriviaDB",
      license_id: "CC-BY-SA-4.0",
    });
  }

  return items;
}

const SOURCE_LABELS: Record<string, string> = {
  MANGA: "Manga",
  LIGHT_NOVEL: "Light Novel",
  ORIGINAL: "Original Story",
  VISUAL_NOVEL: "Visual Novel",
  VIDEO_GAME: "Video Game",
  WEB_NOVEL: "Web Novel",
  OTHER: "Other Media",
};

function shuffleWithRng<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let k = copy.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    const tmp = copy[k]!;
    copy[k] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

function makeMcq(
  id: string,
  prompt: string,
  correct: string,
  distractors: string[],
  difficulty: DifficultyTier,
  note: string,
  sourceName: string,
  subtrackId = "trivia-anime"
): ContentShardItem | null {
  const cleanPrompt = normalizeUtf8Text(prompt);
  const cleanCorrect = normalizeUtf8Text(correct);
  if (!isCleanText(cleanPrompt, 220) || !isCleanText(cleanCorrect, 140)) return null;

  const uniqueDistractors: string[] = [];
  const used = new Set<string>([normalizeForMatching(cleanCorrect)]);
  for (const d of distractors) {
    const cd = normalizeUtf8Text(d);
    const dn = normalizeForMatching(cd);
    if (isCleanText(cd, 140) && !used.has(dn)) {
      used.add(dn);
      uniqueDistractors.push(cd);
      if (uniqueDistractors.length === 3) break;
    }
  }
  if (uniqueDistractors.length < 3) return null;

  const rng = mulberry32(fnv1a32(id));
  const options = shuffleWithRng([cleanCorrect, ...uniqueDistractors], rng) as [
    string,
    string,
    string,
    string,
  ];
  const correctIndex = options.indexOf(cleanCorrect) as 0 | 1 | 2 | 3;

  return {
    item_id: id,
    track_id: "trivia",
    subtrack_id: subtrackId,
    difficulty,
    prompt: cleanPrompt,
    options_4: options,
    correct_index: correctIndex,
    deterministic_note: note,
    source_name: sourceName,
    license_id: "PUBLIC-FACTUAL-API",
  };
}

/**
 * Generate verified factual anime trivia cards from AniList & Kitsu public metadata
 * (studio, premiere year, source adaptation, English/Romaji title matching).
 */
export function buildFactualAnimeTriviaItems(
  anilistRows: RawAniListMedia[],
  kitsuRows: RawKitsuAnime[],
  existingPromptNorms: Set<string>
): ContentShardItem[] {
  const items: ContentShardItem[] = [];
  const seenPrompts = new Set<string>(existingPromptNorms);

  const pushUnique = (item: ContentShardItem | null) => {
    if (!item) return;
    const pNorm = normalizeForMatching(item.prompt);
    if (seenPrompts.has(pNorm)) return;
    seenPrompts.add(pNorm);
    items.push(item);
  };

  // Studio pool & English title pool from AniList
  const studioPool = Array.from(
    new Set(
      anilistRows
        .flatMap((m) => m.studios?.nodes?.map((n) => normalizeUtf8Text(n.name ?? "")) ?? [])
        .filter((s) => s.length >= 2)
    )
  );
  const englishTitlePool = Array.from(
    new Set(
      anilistRows
        .map((m) => normalizeUtf8Text(m.title?.english ?? ""))
        .filter((t) => t.length >= 3 && t.length <= 80)
    )
  );
  const sourcePool = ["Manga", "Light Novel", "Original Story", "Visual Novel", "Video Game", "Web Novel"];

  for (let i = 0; i < anilistRows.length; i++) {
    const m = anilistRows[i]!;
    const title = normalizeUtf8Text(m.title?.english || m.title?.romaji || "");
    if (!title || title.length > 90) continue;
    const diff: DifficultyTier = i < 120 ? "beginner" : i < 260 ? "intermediate" : "challenge";

    // 1. Studio question (only when unambiguous single main studio)
    const studios = m.studios?.nodes?.map((s) => normalizeUtf8Text(s.name ?? "")).filter(Boolean) ?? [];
    if (studios.length === 1 && studioPool.length >= 10) {
      const studio = studios[0]!;
      const rng = mulberry32(fnv1a32(`al-studio:${m.id}`));
      const dStudios = shuffleWithRng(
        studioPool.filter((s) => normalizeForMatching(s) !== normalizeForMatching(studio)),
        rng
      );
      pushUnique(
        makeMcq(
          `al-st-${m.id}`,
          `Which animation studio produced "${title}"?`,
          studio,
          dStudios,
          diff,
          `Studio: ${studio}${m.seasonYear ? ` (${m.seasonYear})` : ""}. Source: AniList factual metadata.`,
          "AniList"
        )
      );
    }

    // 2. Premiere year question
    if (m.seasonYear && m.seasonYear >= 1975 && m.seasonYear <= 2025) {
      const yr = m.seasonYear;
      const rng = mulberry32(fnv1a32(`al-year:${m.id}`));
      const offsets = shuffleWithRng([-4, -3, -2, -1, 1, 2, 3, 4], rng)
        .map((d) => yr + d)
        .filter((y) => y >= 1970 && y <= 2026)
        .map(String);
      pushUnique(
        makeMcq(
          `al-yr-${m.id}`,
          `In which year did the anime "${title}" premiere?`,
          String(yr),
          offsets,
          diff,
          `"${title}" premiered in ${yr}. Source: AniList factual metadata.`,
          "AniList"
        )
      );
    }

    // 3. Romaji <-> English title question
    const romaji = normalizeUtf8Text(m.title?.romaji ?? "");
    const english = normalizeUtf8Text(m.title?.english ?? "");
    if (
      romaji &&
      english &&
      normalizeForMatching(romaji) !== normalizeForMatching(english) &&
      !english.toLowerCase().includes(romaji.toLowerCase()) &&
      !romaji.toLowerCase().includes(english.toLowerCase()) &&
      englishTitlePool.length >= 10
    ) {
      const rng = mulberry32(fnv1a32(`al-title:${m.id}`));
      const dTitles = shuffleWithRng(
        englishTitlePool.filter((t) => normalizeForMatching(t) !== normalizeForMatching(english)),
        rng
      );
      pushUnique(
        makeMcq(
          `al-ti-${m.id}`,
          `What is the official English title of "${romaji}"?`,
          english,
          dTitles,
          diff,
          `"${romaji}" is titled "${english}" in English. Source: AniList factual metadata.`,
          "AniList"
        )
      );
    }

    // 4. Source medium question
    const srcLabel = m.source ? SOURCE_LABELS[m.source] : undefined;
    if (srcLabel && sourcePool.includes(srcLabel)) {
      const rng = mulberry32(fnv1a32(`al-src:${m.id}`));
      const dSrc = shuffleWithRng(
        sourcePool.filter((s) => s !== srcLabel),
        rng
      );
      pushUnique(
        makeMcq(
          `al-sr-${m.id}`,
          `What source medium was "${title}" originally based on?`,
          srcLabel,
          dSrc,
          diff,
          `"${title}" originated as a ${srcLabel}. Source: AniList factual metadata.`,
          "AniList"
        )
      );
    }
  }

  // Supplement with Kitsu premiere years for titles not already asked
  for (let i = 0; i < kitsuRows.length; i++) {
    const k = kitsuRows[i]!;
    const title = normalizeUtf8Text(k.canonicalTitle || k.titles?.en || k.titles?.en_jp || "");
    const yearStr = k.startDate?.slice(0, 4);
    const yr = yearStr ? Number.parseInt(yearStr, 10) : NaN;
    if (!title || !Number.isFinite(yr) || yr < 1975 || yr > 2025) continue;
    const rng = mulberry32(fnv1a32(`kit-yr:${k.id}`));
    const offsets = shuffleWithRng([-3, -2, -1, 1, 2, 3], rng).map((d) => String(yr + d));
    pushUnique(
      makeMcq(
        `kit-yr-${k.id}`,
        `In which year did the anime "${title}" premiere?`,
        String(yr),
        offsets,
        i < 80 ? "beginner" : "intermediate",
        `"${title}" first aired in ${yr}. Source: Kitsu factual metadata.`,
        "Kitsu"
      )
    );
  }

  return items;
}

const POWER_HEADER_KEYS = new Set([
  "quirk",
  "cursed technique",
  "domain expansion",
  "devil fruit",
  "stand",
  "nen",
  "breathing style",
  "combat style",
  "fighting style",
  "magic",
  "alchemy",
  "geass",
  "kagune",
  "titan",
  "zanpakuto",
  "zanpakutou",
  "bankai",
  "weapon",
  "weapons",
  "ability",
  "abilities",
  "powers",
  "power",
  "devil contracts",
]);

const ROLE_HEADER_KEYS = new Set([
  "occupation",
  "affiliation",
  "affiliations",
  "allegiance",
  "organization",
  "squad",
  "team",
  "clan",
  "guild",
  "school",
  "position",
  "rank",
  "grade",
  "title",
  "epithet",
  "alias",
  "aliases",
  "instrument",
]);

const GENERIC_NAME_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "into",
  "that",
  "this",
  "who",
  "captain",
  "prince",
  "princess",
  "king",
  "queen",
  "emperor",
  "empress",
  "lord",
  "lady",
  "sir",
  "saint",
  "god",
  "devil",
  "demon",
  "master",
  "knight",
  "hero",
  "doctor",
  "professor",
  "general",
  "major",
  "commander",
  "white",
  "black",
  "red",
  "blue",
  "green",
  "gold",
  "silver",
  "dark",
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "san",
  "kun",
  "chan",
  "sama",
  "sensei",
  "senpai",
  "boy",
  "girl",
  "man",
  "woman",
  "little",
  "great",
  "young",
  "old",
  "new",
  "high",
  "big",
  "junior",
  "senior",
]);

const GENERIC_ANIME_TAGS = new Set([
  "shounen",
  "seinen",
  "shoujo",
  "josei",
  "male protagonist",
  "female protagonist",
  "primarily teen cast",
  "primarily male cast",
  "primarily female cast",
  "primarily adult cast",
  "ensemble cast",
  "full cgi",
  "cgi",
  "episodic",
  "anthology",
  "gore",
  "nudity",
  "ecchi",
]);

const FRANCHISE_RELATIONS = new Set([
  "SEQUEL",
  "PREQUEL",
  "SIDE_STORY",
  "SPIN_OFF",
  "ALTERNATIVE",
]);

function foldMacrons(input: string): string {
  return input
    .normalize("NFC")
    .replace(/[ōŌ]/g, "o")
    .replace(/[ūŪ]/g, "u")
    .replace(/[āĀ]/g, "a")
    .replace(/[ēĒ]/g, "e")
    .replace(/[īĪ]/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandRomajiVariants(token: string): string[] {
  const base = foldMacrons(token).toLowerCase().trim();
  if (base.length < 3) return [];
  const out = new Set<string>([base]);
  const transforms: Array<[string, string]> = [
    ["ou", "o"],
    ["o", "ou"],
    ["uu", "u"],
    ["u", "uu"],
    ["oo", "o"],
    ["aa", "a"],
  ];
  for (const [from, to] of transforms) {
    if (base.includes(from)) {
      const candidate = base.replaceAll(from, to);
      if (candidate.length >= 3 && !GENERIC_NAME_STOPWORDS.has(candidate)) {
        out.add(candidate);
      }
    }
  }
  return Array.from(out);
}

interface ForbiddenNameChecker {
  phraseAndTokenRegexes: RegExp[];
  nativeTokens: string[];
  seriesTokens: RegExp[];
  leaksInto(text: string): boolean;
  leaksIntoSeriesTitle(title: string): boolean;
}

function buildForbiddenChecker(c: RawAniListCharacter): ForbiddenNameChecker {
  const full = normalizeUtf8Text(c.name?.full ?? "");
  const native = normalizeUtf8Text(c.name?.native ?? "");
  const rawNames = [
    full,
    ...(c.name?.alternative ?? []),
    ...(c.name?.alternativeSpoiler ?? []),
  ]
    .map((s) => normalizeUtf8Text(s ?? ""))
    .filter((s) => s.length >= 2);

  const latinTerms = new Set<string>();
  const seriesTerms = new Set<string>();
  const nativeTokens: string[] = [];

  if (native.length >= 2) {
    nativeTokens.push(native.toLowerCase());
  }

  for (const raw of rawNames) {
    const folded = foldMacrons(raw).toLowerCase().trim();
    if (folded.length >= 3 && !GENERIC_NAME_STOPWORDS.has(folded)) {
      latinTerms.add(folded);
      seriesTerms.add(folded);
    }
    const parts = folded
      .split(/[\s\-·•,/()."“”'’]+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 3 && !GENERIC_NAME_STOPWORDS.has(p));
    for (const part of parts) {
      if (hasJapanese(part) || hasHangul(part)) {
        nativeTokens.push(part);
        continue;
      }
      for (const variant of expandRomajiVariants(part)) {
        latinTerms.add(variant);
        if (variant.length >= 4) {
          seriesTerms.add(variant);
        }
      }
    }
  }

  const toRegex = (term: string) =>
    new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:['’]?s)?(?=$|[^a-z0-9])`, "i");

  const phraseAndTokenRegexes = Array.from(latinTerms).map(toRegex);
  const seriesTokens = Array.from(seriesTerms).map(toRegex);

  const fullFolded = foldMacrons(full).toLowerCase().trim();

  return {
    phraseAndTokenRegexes,
    nativeTokens,
    seriesTokens,
    leaksInto(text: string): boolean {
      const folded = foldMacrons(text).toLowerCase();
      if (fullFolded.length >= 4 && folded.includes(fullFolded)) return true;
      if (nativeTokens.some((nt) => folded.includes(nt))) return true;
      return phraseAndTokenRegexes.some((re) => re.test(folded));
    },
    leaksIntoSeriesTitle(title: string): boolean {
      const folded = foldMacrons(title).toLowerCase();
      if (fullFolded.length >= 4 && folded.includes(fullFolded)) return true;
      if (nativeTokens.some((nt) => folded.includes(nt))) return true;
      return seriesTokens.some((re) => re.test(folded));
    },
  };
}

function stripMarkupAndSpoilers(raw: string): string {
  return raw
    .replace(/~![\s\S]*?!~/g, " ")
    .replace(/<span[^>]*spoiler[^>]*>[\s\S]*?<\/span>/gi, " ")
    .replace(/\[spoiler\][\s\S]*?\[\/spoiler\]/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\/?[a-z]+(?:=[^\]]*)?\]/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .normalize("NFC");
}

function truncateCluePhrase(text: string, maxLen = 104): string {
  const cleaned = normalizeUtf8Text(text).replace(/[;:,]+$/, "").trim();
  if (cleaned.length <= maxLen) return cleaned;
  const slice = cleaned.slice(0, maxLen - 1);
  const lastComma = slice.lastIndexOf(",");
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastComma >= 45 ? lastComma : lastSpace >= 40 ? lastSpace : slice.length;
  return slice
    .slice(0, cut)
    .replace(/[,;:\s]+$/, "")
    .replace(/\b(?:the|a|an|of|in|to|for|with|and|or|by|as|from|at|on|very|strong|own|their|his|her|its)$/i, "")
    .replace(/[,;:\s]+$/, "")
    .trim();
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

const DANGLING_START_RE =
  /^(?:he|she|they|his|her|their|him|them|it|its|this|that|these|those|and|but|however|although|though|when|while|after|before|as|despite|because|since|who|whom|whose|which|also|still|often|sometimes|usually|originally|initially)\b/i;

const ACTION_VERBS_RE =
  /^(?:[A-Z][^\s,]{1,24}(?:\s+[A-Z][^\s,]{1,24}){0,2}|He|She|They)\s+(wields|leads|serves as|works as|acts as|poses as|fights as|pilots|commands|runs|owns|belongs to|joined|founded|protects|hunts|seeks|uses|possesses|carries|controls|trains|guards|rules|serves)\s+(.+)$/;

const COPULA_SENTENCE_RE =
  /^(?:[A-Z][^\s,]{1,24}(?:\s+[A-Z][^\s,]{1,24}){0,2}|He|She|They)\s+(?:is|was|are|were)\s+(?:one of the\s+|known as\s+|described as\s+|introduced as\s+)?(?:(?:a|an|the)\s+)?(.+)$/;

type FocusAngle = "conflict" | "power" | "role";

interface SynthesizedCharacterClues {
  powerHeader: string | null;
  roleHeader: string | null;
  synthesizedClue: string | null;
  focusAngle: FocusAngle;
}

function classifyFocusAngle(text: string, hasPowerHeader: boolean): FocusAngle {
  if (
    /\b(?:antagonist|villain|rival|enemy|arch|murder|killer|assassin|outlaw|demon|curse|pirate|evil|revenge|war|crime|phantom|terror|dark|akatsuki|espada|corrupt)\b/i.test(
      text
    )
  ) {
    return "conflict";
  }
  if (
    hasPowerHeader ||
    /\b(?:wield|power|ability|quirk|magic|sword|blade|weapon|fruit|cursed|breathing|stand|nen|bankai|titan|immortal|control|transform|pilots|alchemy|sharingan|spell)\b/i.test(
      text
    )
  ) {
    return "power";
  }
  return "role";
}

function extractCharacterClues(
  description: string | null | undefined,
  checker: ForbiddenNameChecker
): SynthesizedCharacterClues {
  if (!description) {
    return { powerHeader: null, roleHeader: null, synthesizedClue: null, focusAngle: "role" };
  }

  const cleanBlock = stripMarkupAndSpoilers(description);
  const lines = cleanBlock.split(/\r?\n/);

  let powerHeader: string | null = null;
  let roleHeader: string | null = null;
  let bareSpecies: string | null = null;
  const proseLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const headerMatch = line.match(
      /^\s*(?:__|\*\*)([A-Za-z][A-Za-z \-]{1,30}):?(?:__|\*\*)\s*:?\s*(.+)$/
    );
    if (headerMatch) {
      const rawKey = headerMatch[1]!.trim();
      const keyLower = rawKey.toLowerCase();
      const val = normalizeUtf8Text(headerMatch[2]!.replace(/[*_`~]/g, ""))
        .replace(/[,;]+$/, "")
        .trim();
      if (
        !val ||
        val.length < 2 ||
        val.length > 72 ||
        /^(?:unknown|none|n\/a|-|deceased|alive|spoiler)$/i.test(val) ||
        checker.leaksInto(val) ||
        hasResidualHtmlArtifacts(val) ||
        /[[\]<>]/.test(val)
      ) {
        continue;
      }
      if (POWER_HEADER_KEYS.has(keyLower) && !powerHeader) {
        powerHeader = `${rawKey}: ${val}`;
      } else if (ROLE_HEADER_KEYS.has(keyLower)) {
        if ((keyLower === "race" || keyLower === "species") && /^human$/i.test(val)) {
          bareSpecies = val;
          continue;
        }
        if (!roleHeader) {
          roleHeader = `${rawKey}: ${val}`;
        }
      }
      continue;
    }

    // Skip section headings like "__Series 1__" or "# Trivia"
    if (/^(?:__|\*\*|#)/.test(line) && line.length < 55) continue;
    proseLines.push(line.replace(/[*_`~]/g, ""));
  }

  // Only include non-Human race/species if needed; bare Human is already excluded above
  void bareSpecies;

  const proseText = proseLines.join(" ").replace(/\s+/g, " ").trim();
  const sentences = proseText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18 && s.length <= 260);

  let bestClue: string | null = null;
  let bestScore = -1;

  for (const sent of sentences.slice(0, 6)) {
    const noEndPunct = sent.replace(/[.!?]+$/, "").trim();
    let candidate: string | null = null;

    const actionMatch = noEndPunct.match(ACTION_VERBS_RE);
    if (actionMatch) {
      candidate = `${capitalizeFirst(actionMatch[1]!)} ${actionMatch[2]!}`;
    } else {
      const copulaMatch = noEndPunct.match(COPULA_SENTENCE_RE);
      if (copulaMatch) {
        candidate = capitalizeFirst(copulaMatch[1]!);
      } else if (
        /^(?:Protagonist|Main protagonist|Antagonist|Main antagonist|Rival|Member|Leader|Captain|Founder|Commander|Student|Teacher|Third-year|Second-year|First-year|Former|Water pillar|Special|Outlaw|Immortal|Original)\b/i.test(
          noEndPunct
        )
      ) {
        candidate = capitalizeFirst(noEndPunct);
      } else if (/^(?:A|An|The)\s+(?:member|leader|captain|student|teacher|protagonist|antagonist|rival|sorcerer|shinigami|alchemist|ninja|knight|pirate|pilot|detective|assassin|demon|warrior|outlaw|princess|prince|queen|king)\b/i.test(noEndPunct)) {
        candidate = capitalizeFirst(noEndPunct.replace(/^(?:A|An|The)\s+/i, ""));
      }
    }

    if (!candidate) continue;
    candidate = truncateCluePhrase(candidate, 102);

    if (
      candidate.length < 18 ||
      candidate.length >= 110 ||
      DANGLING_START_RE.test(candidate) ||
      checker.leaksInto(candidate) ||
      hasResidualHtmlArtifacts(candidate) ||
      /[[\]<>]/.test(candidate) ||
      /\b(?:he|she|his|her|him)\b/i.test(candidate.slice(0, 14))
    ) {
      continue;
    }

    // Score richness & focus angle priority (conflict/power/role > generic)
    const angle = classifyFocusAngle(candidate, Boolean(powerHeader));
    const angleBonus = angle === "conflict" ? 3 : angle === "power" ? 2 : 1;
    const score = angleBonus * 10 + Math.min(candidate.length, 90) / 20;
    if (score > bestScore) {
      bestScore = score;
      bestClue = candidate;
    }
  }

  const combinedText = [powerHeader, roleHeader, bestClue].filter(Boolean).join(" ");
  const focusAngle = classifyFocusAngle(combinedText, Boolean(powerHeader));

  return {
    powerHeader,
    roleHeader,
    synthesizedClue: bestClue,
    focusAngle,
  };
}

function normalizeBaseSeriesTitle(title: string): string {
  return foldMacrons(title)
    .toLowerCase()
    .replace(/:\s.*$/, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+(?:season|part|cour|movie|ova|special|final season|shippuden|shippuuden)\b.*$/i, "")
    .replace(/\s+(?:ii|iii|iv|v|[2-9])$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Generates "Who's That Anime?" (trivia-anime-characters) cards (target >= 250)
 * with synthesized story/conflict/power clues, strict zero-spoiler & zero-leak
 * validation, franchise-grouped era/genre-matched distractors, and <= 5% VA-only cap.
 */
export function buildCharacterTriviaItems(rawChars: RawAniListCharacter[]): ContentShardItem[] {
  interface CandidateChar {
    id: number;
    name: string;
    nameNorm: string;
    nativeName: string;
    animeId: number;
    animeTitle: string;
    franchiseKey: string;
    roleTier: "MAIN" | "SUPPORTING";
    eraBucket: number | null;
    genres: string[];
    tags: string[];
    year: number | null;
    studio: string;
    va: string;
    clues: SynthesizedCharacterClues;
    checker: ForbiddenNameChecker;
    favRank: number;
  }

  // 1. Build Union-Find franchise clustering across AniList media IDs, relations, and base titles
  const ufParent = new Map<number, number>();
  const findRoot = (id: number): number => {
    let cur = id;
    while (ufParent.has(cur) && ufParent.get(cur) !== cur) {
      cur = ufParent.get(cur)!;
    }
    return cur;
  };
  const unionIds = (a: number, b: number) => {
    const ra = findRoot(a);
    const rb = findRoot(b);
    if (ra !== rb) {
      const root = Math.min(ra, rb);
      ufParent.set(ra, root);
      ufParent.set(rb, root);
    }
  };
  const baseTitleFirstMediaId = new Map<string, number>();

  for (const c of rawChars) {
    for (const edge of c.media?.edges ?? []) {
      const node = edge.node;
      if (!node || node.isAdult) continue;
      if (!ufParent.has(node.id)) ufParent.set(node.id, node.id);

      const rawTitle = normalizeUtf8Text(node.title?.english || node.title?.romaji || "");
      const baseTitle = normalizeBaseSeriesTitle(rawTitle);
      if (baseTitle.length >= 4) {
        const existingId = baseTitleFirstMediaId.get(baseTitle);
        if (existingId !== undefined) unionIds(node.id, existingId);
        else baseTitleFirstMediaId.set(baseTitle, node.id);
      }

      for (const rel of node.relations?.edges ?? []) {
        if (!rel.node?.id || !rel.relationType || !FRANCHISE_RELATIONS.has(rel.relationType)) {
          continue;
        }
        if (!ufParent.has(rel.node.id)) ufParent.set(rel.node.id, rel.node.id);
        unionIds(node.id, rel.node.id);
      }
    }
  }

  const candidates: CandidateChar[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < rawChars.length; i++) {
    const c = rawChars[i]!;
    const fullName = normalizeUtf8Text(c.name?.full ?? "");
    const nameNorm = normalizeForMatching(fullName);
    if (!fullName || fullName.length < 3 || fullName.length > 48 || seenNames.has(nameNorm)) {
      continue;
    }
    if (hasResidualHtmlArtifacts(fullName)) continue;

    const edge = c.media?.edges?.find((e) => {
      const n = e.node;
      if (!n || n.isAdult) return false;
      if (n.genres?.some((g) => g === "Hentai" || g === "Ecchi")) return false;
      const t = normalizeUtf8Text(n.title?.english || n.title?.romaji || "");
      return t.length >= 2 && t.length <= 68 && !hasResidualHtmlArtifacts(t);
    });
    if (!edge?.node) continue;

    const animeTitle = normalizeUtf8Text(edge.node.title?.english || edge.node.title?.romaji || "");
    const checker = buildForbiddenChecker(c);

    // Series title leak guard: skip characters whose name token appears inside the anime title
    if (checker.leaksIntoSeriesTitle(animeTitle)) continue;

    const va = normalizeUtf8Text(edge.voiceActors?.[0]?.name?.full ?? "");
    const studio = normalizeUtf8Text(edge.node.studios?.nodes?.[0]?.name ?? "");
    const nativeName = normalizeUtf8Text(c.name?.native ?? "");
    const roleTier = edge.characterRole === "MAIN" ? "MAIN" : "SUPPORTING";
    const year = edge.node.seasonYear ?? null;
    const eraBucket = year ? Math.floor(year / 5) * 5 : null;

    const safeTags = (edge.node.tags ?? [])
      .filter(
        (t) =>
          !t.isMediaSpoiler &&
          (t.rank ?? 0) >= 60 &&
          t.name &&
          !GENERIC_ANIME_TAGS.has(t.name.toLowerCase()) &&
          !checker.leaksInto(t.name)
      )
      .slice(0, 2)
      .map((t) => normalizeUtf8Text(t.name!));

    const clues = extractCharacterClues(c.description, checker);
    const hasNonVaClue = Boolean(
      clues.powerHeader || clues.roleHeader || clues.synthesizedClue
    );
    if (!hasNonVaClue && !va) continue;

    const franchiseRoot = findRoot(edge.node.id);
    const baseTitle = normalizeBaseSeriesTitle(animeTitle);
    const franchiseKey =
      baseTitle.length >= 4 ? `${franchiseRoot}:${baseTitle}` : String(franchiseRoot);

    seenNames.add(nameNorm);
    candidates.push({
      id: c.id,
      name: fullName,
      nameNorm,
      nativeName,
      animeId: edge.node.id,
      animeTitle,
      franchiseKey,
      roleTier,
      eraBucket,
      genres: edge.node.genres ?? [],
      tags: safeTags,
      year,
      studio,
      va,
      clues,
      checker,
      favRank: i,
    });
  }

  const nonVaItems: ContentShardItem[] = [];
  const vaOnlyItems: ContentShardItem[] = [];
  const seenPrompts = new Set<string>();

  for (const cand of candidates) {
    const distinctFranchise = candidates.filter(
      (other) =>
        other.id !== cand.id &&
        other.animeId !== cand.animeId &&
        other.franchiseKey !== cand.franchiseKey &&
        normalizeBaseSeriesTitle(other.animeTitle) !== normalizeBaseSeriesTitle(cand.animeTitle)
    );
    const sameRole = distinctFranchise.filter((o) => o.roleTier === cand.roleTier);
    const sameEraAndGenre = sameRole.filter(
      (o) =>
        cand.eraBucket !== null &&
        o.eraBucket === cand.eraBucket &&
        o.genres.some((g) => cand.genres.includes(g))
    );
    const sameGenre = sameRole.filter((o) => o.genres.some((g) => cand.genres.includes(g)));
    const sameEra = sameRole.filter(
      (o) => cand.eraBucket !== null && o.eraBucket === cand.eraBucket
    );

    const rng = mulberry32(fnv1a32(`char:${cand.id}`));
    const orderedDistractors = [
      ...shuffleWithRng(sameEraAndGenre, rng),
      ...shuffleWithRng(sameGenre, rng),
      ...shuffleWithRng(sameEra, rng),
      ...shuffleWithRng(sameRole, rng),
      ...shuffleWithRng(distinctFranchise, rng),
    ].map((o) => o.name);

    const roleLabel = cand.roleTier === "MAIN" ? "main" : "supporting";
    const metaParts = [cand.year ? String(cand.year) : "", cand.studio].filter(Boolean).join(", ");
    const seriesBit = metaParts ? `"${cand.animeTitle}" (${metaParts})` : `"${cand.animeTitle}"`;
    const tagBit = cand.tags.length > 0 ? cand.tags.join(", ") : cand.genres.slice(0, 2).join(", ");

    let prompt = "";
    let isVaOnly = false;
    const { powerHeader, roleHeader, synthesizedClue, focusAngle } = cand.clues;

    if (synthesizedClue && powerHeader) {
      prompt = `In ${seriesBit}, which ${roleLabel} character (${powerHeader}) fits: ${synthesizedClue}?`;
      if (prompt.length > 215) {
        prompt = `In ${seriesBit}, which ${roleLabel} character (${powerHeader}) fits: ${truncateCluePhrase(synthesizedClue, 76)}?`;
      }
    } else if (synthesizedClue && roleHeader) {
      prompt = `In ${seriesBit}, which ${roleLabel} character (${roleHeader}) fits: ${synthesizedClue}?`;
      if (prompt.length > 215) {
        prompt = `In ${seriesBit}, which character fits: ${synthesizedClue}?`;
      }
    } else if (synthesizedClue) {
      const lead =
        focusAngle === "conflict"
          ? `rival/conflict figure`
          : focusAngle === "power"
          ? `${roleLabel} fighter`
          : `${roleLabel} character`;
      prompt = `In ${seriesBit}, which ${lead} fits: ${synthesizedClue}?`;
    } else if (powerHeader && roleHeader) {
      prompt = `Which ${roleLabel} character in ${seriesBit} matches ${powerHeader} · ${roleHeader}?`;
    } else if (powerHeader) {
      prompt = `Which ${roleLabel} character in ${seriesBit} is defined by ${powerHeader}?`;
    } else if (roleHeader) {
      prompt = `Which ${roleLabel} character in ${seriesBit} holds ${roleHeader}?`;
    } else if (cand.va) {
      isVaOnly = true;
      prompt = `Who is the ${roleLabel} character in ${seriesBit} voiced in Japanese by ${cand.va}?`;
    } else {
      continue;
    }
    void tagBit;

    if (prompt.length > 220) {
      prompt = `${prompt.slice(0, 217).replace(/\s+\S*$/, "")}?`;
    }

    // Comprehensive zero-leak & zero-artifact guard
    if (
      prompt.length < 20 ||
      prompt.length > 220 ||
      cand.checker.leaksInto(prompt) ||
      hasResidualHtmlArtifacts(prompt) ||
      /~!|!~|<[^>]+>|\[\/?[a-z]+/i.test(prompt)
    ) {
      continue;
    }

    const diff: DifficultyTier =
      cand.favRank < 150 ? "beginner" : cand.favRank < 340 ? "intermediate" : "challenge";
    const note = `${cand.name}${cand.nativeName ? ` (${cand.nativeName})` : ""} is a ${roleLabel} character from "${cand.animeTitle}"${cand.va ? ` (JP voice: ${cand.va})` : ""}. Source: AniList factual metadata.`;

    const built = makeMcq(
      `al-char-${cand.id}`,
      prompt,
      cand.name,
      orderedDistractors,
      diff,
      note,
      "AniList",
      "trivia-anime-characters"
    );
    if (!built) continue;
    const pNorm = normalizeForMatching(built.prompt);
    if (seenPrompts.has(pNorm)) continue;
    seenPrompts.add(pNorm);

    if (isVaOnly) vaOnlyItems.push(built);
    else nonVaItems.push(built);
  }

  // Emit 0% VA-only cards whenever non-VA cards already reach >= 250; otherwise cap strictly <= 5%
  if (nonVaItems.length >= 250) {
    return nonVaItems;
  }
  const maxVaAllowed = Math.floor((nonVaItems.length * 0.05) / 0.95);
  return [...nonVaItems, ...vaOnlyItems.slice(0, maxVaAllowed)];
}

export function chunkIntoShards(
  items: ContentShardItem[],
  subtrackId: string,
  trackId: TrackGroup,
  label: string,
  licenseId: LicenseId,
  maxItemsPerShard = 150,
  sourceLang?: string,
  targetLang?: string
): Array<{ meta: ShardMeta; fileRelPath: string; jsonText: string; items: ContentShardItem[] }> {
  const licenseFolder = licenseId.toLowerCase();
  const out: Array<{
    meta: ShardMeta;
    fileRelPath: string;
    jsonText: string;
    items: ContentShardItem[];
  }> = [];

  for (let offset = 0, idx = 1; offset < items.length; offset += maxItemsPerShard, idx++) {
    const slice = items.slice(offset, offset + maxItemsPerShard);
    const shardId = `${subtrackId}-${licenseFolder}-s${String(idx).padStart(2, "0")}`;
    const fileRelPath = `packs/${licenseFolder}/${shardId}.json`;
    const jsonText = JSON.stringify({
      schema_version: 1,
      shard_id: shardId,
      subtrack_id: subtrackId,
      track_id: trackId,
      license_id: licenseId,
      items: slice,
    });
    const bytes = Buffer.byteLength(jsonText, "utf8");
    out.push({
      meta: {
        shard_id: shardId,
        subtrack_id: subtrackId,
        track_id: trackId,
        label,
        source_lang: sourceLang,
        target_lang: targetLang,
        license_id: licenseId,
        url: `/${fileRelPath}`,
        item_count: slice.length,
        bytes,
        sha256: sha256Hex(jsonText),
      },
      fileRelPath,
      jsonText,
      items: slice,
    });
  }

  return out;
}

export function buildDailyManifests(
  itemsBySubtrack: Map<string, ContentShardItem[]>,
  shardLookupByItemId: Map<string, string>,
  startDateIso: string,
  daysCount = 30
): DailyManifest[] {
  const manifests: DailyManifest[] = [];
  const start = new Date(`${startDateIso}T00:00:00.000Z`);

  for (let d = 0; d < daysCount; d++) {
    const dt = new Date(start.getTime() + d * 86_400_000);
    const utcDate = dt.toISOString().slice(0, 10);

    for (const [subtrackId, items] of itemsBySubtrack.entries()) {
      if (items.length < 5) continue;
      const rng = mulberry32(fnv1a32(`daily:${utcDate}:${subtrackId}`));
      const chosenIds: string[] = [];
      const usedIdx = new Set<number>();
      while (chosenIds.length < 5) {
        const idx = Math.floor(rng() * items.length);
        if (!usedIdx.has(idx)) {
          usedIdx.add(idx);
          chosenIds.push(items[idx]!.item_id);
        }
      }
      const shardUrls = Array.from(
        new Set(chosenIds.map((id) => shardLookupByItemId.get(id)!).filter(Boolean))
      );
      manifests.push({
        schema_version: 1,
        utc_date: utcDate,
        subtrack_id: subtrackId,
        item_ids: chosenIds,
        shard_urls: shardUrls,
      });
    }
  }
  return manifests;
}

export function assembleCatalog(
  shards: ShardMeta[],
  tracksInfo: PackCatalog["tracks"],
  dailyDates: string[],
  generatedAt = new Date().toISOString()
): PackCatalog {
  const totalItems = shards.reduce((acc, s) => acc + s.item_count, 0);
  return {
    schema_version: 1,
    generated_at: generatedAt,
    total_items: totalItems,
    tracks: tracksInfo,
    shards,
    daily_dates: dailyDates,
  };
}
