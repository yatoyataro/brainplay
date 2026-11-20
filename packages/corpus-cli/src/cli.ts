import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleCatalog,
  buildCharacterTriviaItems,
  buildDailyManifests,
  buildFactualAnimeTriviaItems,
  buildPhraseItems,
  buildTriviaItems,
  chunkIntoShards,
  DEFAULT_TRACK1_PAIRS,
  parseLinksTsv,
  parseSentencesTsv,
  type RawAniListCharacter,
  type RawAniListMedia,
  type RawKitsuAnime,
  type RawOpenTriviaRow,
  type RawSentenceRow,
} from "./curation.ts";
import { createJapaneseRomanizer } from "./romanize.ts";
import {
  hasResidualHtmlArtifacts,
  normalizeForMatching,
  normalizeUtf8Text,
} from "../../../src/core/normalize.ts";
import type { ContentShardItem, PackCatalog, ShardMeta } from "../../../src/core/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "../../..");
const CACHE_DIR = join(APP_ROOT, ".cache", "corpus");
const PUBLIC_DIR = join(APP_ROOT, "public");
const GENERATED_WORKER_DIR = join(APP_ROOT, "worker", "src", "generated");

function readCacheText(name: string): string {
  return readFileSync(join(CACHE_DIR, name), "utf8");
}

async function streamEnglishSentencesForLinks(
  neededIds: Set<string>
): Promise<Map<string, RawSentenceRow>> {
  const map = new Map<string, RawSentenceRow>();
  const rl = createInterface({
    input: createReadStream(join(CACHE_DIR, "eng_sentences_detailed.tsv"), { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    const id = cols[0]?.trim() ?? "";
    if (!id || !neededIds.has(id) || cols[1]?.trim() !== "eng") continue;
    const text = normalizeUtf8Text(cols[2] ?? "");
    if (
      text.length < 2 ||
      text.length > 140 ||
      hasResidualHtmlArtifacts(text) ||
      !/[a-zA-Z]/.test(text)
    ) {
      continue;
    }
    const author = cols[3]?.trim() && cols[3] !== "\\N" ? cols[3].trim() : "Tatoeba contributor";
    map.set(id, { id, lang: "eng", text, author });
  }
  return map;
}

function writeCleanFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

async function main(): Promise<void> {
  console.log("Loading raw corpora & initializing Japanese Hepburn analyzer...");
  const jaRomanizer = await createJapaneseRomanizer();
  const kor = parseSentencesTsv(readCacheText("kor_sentences_detailed.tsv"), "kor");
  const jpn = parseSentencesTsv(readCacheText("jpn_sentences_detailed.tsv"), "jpn");

  const korEngLinks = parseLinksTsv(readCacheText("kor-eng_links.tsv"));
  const engJpnLinks = parseLinksTsv(readCacheText("eng-jpn_links.tsv"));
  const neededEngIds = new Set<string>();
  for (const l of korEngLinks) {
    neededEngIds.add(l.sourceId);
    neededEngIds.add(l.targetId);
  }
  for (const l of engJpnLinks) {
    neededEngIds.add(l.sourceId);
    neededEngIds.add(l.targetId);
  }
  const eng = await streamEnglishSentencesForLinks(neededEngIds);

  const opentdbWorldRaw = JSON.parse(readCacheText("opentdb_raw.json")) as RawOpenTriviaRow[];
  const opentdbAnimeRaw = JSON.parse(readCacheText("opentdb_anime_raw.json")) as RawOpenTriviaRow[];
  const anilistRaw = JSON.parse(readCacheText("anilist_anime_raw.json")) as RawAniListMedia[];
  const kitsuRaw = JSON.parse(readCacheText("kitsu_anime_raw.json")) as RawKitsuAnime[];
  const anilistCharsRaw = JSON.parse(readCacheText("anilist_characters_raw.json")) as RawAniListCharacter[];

  console.log(
    `Parsed inputs: eng=${eng.size}, kor=${kor.size}, jpn=${jpn.size}, otdbWorld=${opentdbWorldRaw.length}, otdbAnime=${opentdbAnimeRaw.length}, anilist=${anilistRaw.length}, kitsu=${kitsuRaw.length}, anilistChars=${anilistCharsRaw.length}`
  );

  rmSync(join(PUBLIC_DIR, "packs"), { recursive: true, force: true });
  rmSync(join(PUBLIC_DIR, "data", "daily"), { recursive: true, force: true });

  const sentencesByLang = { eng, kor, jpn };
  const allShards: ShardMeta[] = [];
  const tracksInfo: PackCatalog["tracks"] = [];
  const itemsBySubtrack = new Map<string, ContentShardItem[]>();
  const shardUrlByItemId = new Map<string, string>();
  const allItems: ContentShardItem[] = [];

  for (const pair of DEFAULT_TRACK1_PAIRS) {
    const links =
      pair.source_lang === "kor" || pair.target_lang === "kor" ? korEngLinks : engJpnLinks;
    const items = await buildPhraseItems(
      pair,
      sentencesByLang[pair.source_lang],
      sentencesByLang[pair.target_lang],
      links,
      jaRomanizer
    );
    itemsBySubtrack.set(pair.subtrack_id, items);
    allItems.push(...items);

    const shards = chunkIntoShards(
      items,
      pair.subtrack_id,
      "phrases",
      pair.label,
      "CC-BY-2.0-FR",
      150,
      pair.source_lang,
      pair.target_lang
    );
    for (const shard of shards) {
      writeCleanFile(join(PUBLIC_DIR, shard.fileRelPath), shard.jsonText);
      allShards.push(shard.meta);
      for (const item of shard.items) {
        shardUrlByItemId.set(item.item_id, shard.meta.url);
      }
    }
    tracksInfo.push({
      subtrack_id: pair.subtrack_id,
      track_id: "phrases",
      label: pair.label,
      description: pair.description,
      license_id: "CC-BY-2.0-FR",
      item_count: items.length,
      shards: shards.map((s) => s.meta.url),
    });
    console.log(`  Track 1 [${pair.subtrack_id}]: ${items.length} items across ${shards.length} shards`);
  }

  // Track 2A: Anime Trivia (OpenTriviaDB Cat 31 CC BY-SA 4.0 + AniList/Kitsu factual metadata)
  const otdbAnimeItems = buildTriviaItems(opentdbAnimeRaw, "trivia-anime");
  const animePromptNorms = new Set(otdbAnimeItems.map((i) => normalizeForMatching(i.prompt)));
  const factualAnimeItems = buildFactualAnimeTriviaItems(anilistRaw, kitsuRaw, animePromptNorms);

  const allAnimeItems = [...otdbAnimeItems, ...factualAnimeItems];
  itemsBySubtrack.set("trivia-anime", allAnimeItems);
  allItems.push(...allAnimeItems);

  const animeOtdbShards = chunkIntoShards(
    otdbAnimeItems,
    "trivia-anime",
    "trivia",
    "Anime Trivia",
    "CC-BY-SA-4.0",
    150
  );
  const animeFactualShards = chunkIntoShards(
    factualAnimeItems,
    "trivia-anime",
    "trivia",
    "Anime Trivia",
    "PUBLIC-FACTUAL-API",
    150
  );
  const animeShards = [...animeOtdbShards, ...animeFactualShards];
  for (const shard of animeShards) {
    writeCleanFile(join(PUBLIC_DIR, shard.fileRelPath), shard.jsonText);
    allShards.push(shard.meta);
    for (const item of shard.items) {
      shardUrlByItemId.set(item.item_id, shard.meta.url);
    }
  }
  tracksInfo.push({
    subtrack_id: "trivia-anime",
    track_id: "trivia",
    label: "Anime Trivia",
    description: "Japanese anime & manga trivia — studios, premieres, titles, and classic lore.",
    license_id: "CC-BY-SA-4.0",
    item_count: allAnimeItems.length,
    shards: animeShards.map((s) => s.meta.url),
  });
  console.log(
    `  Track 2A [trivia-anime]: ${allAnimeItems.length} items (${otdbAnimeItems.length} OpenTDB + ${factualAnimeItems.length} factual) across ${animeShards.length} shards`
  );

  // Track 2C: "Who's That Anime?" (250+ verified character trivia cards from AniList public metadata)
  const charTriviaItems = buildCharacterTriviaItems(anilistCharsRaw);
  itemsBySubtrack.set("trivia-anime-characters", charTriviaItems);
  allItems.push(...charTriviaItems);
  const charShards = chunkIntoShards(
    charTriviaItems,
    "trivia-anime-characters",
    "trivia",
    "Who's That Anime?",
    "PUBLIC-FACTUAL-API",
    150
  );
  for (const shard of charShards) {
    writeCleanFile(join(PUBLIC_DIR, shard.fileRelPath), shard.jsonText);
    allShards.push(shard.meta);
    for (const item of shard.items) {
      shardUrlByItemId.set(item.item_id, shard.meta.url);
    }
  }
  tracksInfo.push({
    subtrack_id: "trivia-anime-characters",
    track_id: "trivia",
    label: "Who's That Anime?",
    description: "Story roles, powers, rivals, antagonists, and defining anime moments.",
    license_id: "PUBLIC-FACTUAL-API",
    item_count: charTriviaItems.length,
    shards: charShards.map((s) => s.meta.url),
  });
  console.log(
    `  Track 2C [trivia-anime-characters]: ${charTriviaItems.length} items across ${charShards.length} shards`
  );

  // Track 2B: World, Culture & Science Trivia (exclude any Anime Cat 31 prompt)
  const worldNonAnime = opentdbWorldRaw.filter(
    (r) => !decodeURIComponent(r.category).includes("Japanese Anime")
  );
  const triviaItems = buildTriviaItems(worldNonAnime, "trivia-world");
  itemsBySubtrack.set("trivia-world", triviaItems);
  allItems.push(...triviaItems);
  const triviaShards = chunkIntoShards(
    triviaItems,
    "trivia-world",
    "trivia",
    "World, Culture & Science Trivia",
    "CC-BY-SA-4.0",
    150
  );
  for (const shard of triviaShards) {
    writeCleanFile(join(PUBLIC_DIR, shard.fileRelPath), shard.jsonText);
    allShards.push(shard.meta);
    for (const item of shard.items) {
      shardUrlByItemId.set(item.item_id, shard.meta.url);
    }
  }
  tracksInfo.push({
    subtrack_id: "trivia-world",
    track_id: "trivia",
    label: "World, Culture & Science Trivia",
    description: "General knowledge, geography, science, arts, and culture trivia.",
    license_id: "CC-BY-SA-4.0",
    item_count: triviaItems.length,
    shards: triviaShards.map((s) => s.meta.url),
  });
  console.log(`  Track 2B [trivia-world]: ${triviaItems.length} items across ${triviaShards.length} shards`);

  const dailyManifests = buildDailyManifests(itemsBySubtrack, shardUrlByItemId, "2026-11-19", 30);
  const dailyDates = Array.from(new Set(dailyManifests.map((m) => m.utc_date))).sort();
  for (const m of dailyManifests) {
    writeCleanFile(
      join(PUBLIC_DIR, "data", "daily", m.subtrack_id, `${m.utc_date}.json`),
      JSON.stringify(m)
    );
  }

  const catalog = assembleCatalog(allShards, tracksInfo, dailyDates);
  writeCleanFile(join(PUBLIC_DIR, "packs", "catalog.json"), JSON.stringify(catalog, null, 2));

  // Server-authoritative item lookup index (includes optional romanization for PublicRoomQuestion)
  const serverIndex: Record<
    string,
    {
      subtrack_id: string;
      difficulty: string;
      prompt: string;
      prompt_romanization?: string;
      options_4: [string, string, string, string];
      options_romanization?: [string, string, string, string];
      correct_index: 0 | 1 | 2 | 3;
      deterministic_note: string;
      source_name: string;
      license_id: string;
    }
  > = {};
  for (const item of allItems) {
    serverIndex[item.item_id] = {
      subtrack_id: item.subtrack_id,
      difficulty: item.difficulty,
      prompt: item.prompt,
      ...(item.prompt_romanization ? { prompt_romanization: item.prompt_romanization } : {}),
      options_4: item.options_4,
      ...(item.options_romanization ? { options_romanization: item.options_romanization } : {}),
      correct_index: item.correct_index,
      deterministic_note: item.deterministic_note,
      source_name: item.source_name,
      license_id: item.license_id,
    };
  }
  writeCleanFile(
    join(GENERATED_WORKER_DIR, "serverAnswerIndex.json"),
    JSON.stringify(serverIndex)
  );

  const subtrackItemIds: Record<string, string[]> = {};
  for (const [k, v] of itemsBySubtrack.entries()) {
    subtrackItemIds[k] = v.map((i) => i.item_id);
  }
  writeCleanFile(
    join(GENERATED_WORKER_DIR, "subtrackItemIds.json"),
    JSON.stringify(subtrackItemIds)
  );

  console.log(
    `Total curated items: ${catalog.total_items} | Anime Trivia: ${allAnimeItems.length} (target >= 600) | Who's That Anime?: ${charTriviaItems.length} (target >= 250)`
  );
  console.log(`Daily manifests generated: ${dailyManifests.length} (${dailyDates.length} UTC days)`);
  if (allAnimeItems.length < 600) {
    throw new Error(`Expected >= 600 Anime Trivia items, got ${allAnimeItems.length}`);
  }
  if (charTriviaItems.length < 250) {
    throw new Error(`Expected >= 250 Who's That Anime? character items, got ${charTriviaItems.length}`);
  }
}

void main();
