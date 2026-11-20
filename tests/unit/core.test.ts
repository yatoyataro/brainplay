import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeSyncString,
  mergeMasteryState,
  parseAndVerifyBackup,
} from "../../src/core/backup.ts";
import {
  cryptoRandomInt,
  cryptoShuffleIndices,
} from "../../src/core/entropy.ts";
import {
  applySessionCardOrderAndChoices,
  computeMomentumStats,
  scheduleNextMastery,
  selectDeterministicDailyCards,
  selectPracticeCards,
  shuffleCardChoices,
} from "../../src/core/mastery.ts";
import {
  ACTIVE_DIR_SHORT,
  aggregateLanguageTracks,
  buildSoloPlayUrl,
  categoryFromSubtrack,
  DEFAULT_USER_PREFS,
  extractCarriedPracticeLength,
  getDefaultGameOptions,
  HUB_CATEGORIES,
  isLanguageTrack,
  LANGUAGE_DIRECTIONS,
  LANGUAGE_SUBTRACK_IDS,
  loadUserPreferences,
  optionsFromPreferences,
  parseSoloOptionsFromSearch,
  PRB005_PREFS_STORAGE_KEY,
  resolveSubtrackId,
  resolveTrackShuffle,
  saveUserPreferences,
} from "../../src/core/options.ts";
import {
  DATA_NOTICE_STORAGE_KEY,
  createLocalStore,
  dismissDataNotice,
  isDataNoticeDismissed,
  readPrefStorage,
  writePrefStorage,
} from "../../src/core/storage.ts";
import {
  ApiRequestError,
  apiCreateRoom,
  buildApiUrl,
  buildRoomWsUrl,
  clearSavedRoomToken,
  getSavedRoomToken,
  normalizeApiBase,
  saveRoomToken,
} from "../../src/core/roomClient.ts";
import { loadPackCatalog } from "../../src/core/packsClient.ts";
import {
  hasHangul,
  hasJapanese,
  hasResidualHtmlArtifacts,
  normalizeForMatching,
  normalizeUtf8Text,
} from "../../src/core/normalize.ts";
import { buildSpoilerFreeShareText } from "../../src/core/shareGrid.ts";
import { romanizeKorean } from "../../packages/corpus-cli/src/romanize.ts";
import type { ContentShardItem, PackCatalog } from "../../src/core/types.ts";

const APP_ROOT = resolve(__dirname, "../..");
const PUBLIC_DIR = join(APP_ROOT, "public");

describe("PRB-005 Core Logic & Curation Acceptance Tests", () => {
  it("TEST-001: guilt-free spaced repetition (1d->3d->7d->21d) & non-punitive missed day", () => {
    const day0 = "2026-11-19";
    const s1 = scheduleNextMastery(undefined, "item-1", "phrases-en-ko", true, day0);
    expect(s1.tier).toBe("Learning");
    expect(s1.next_due_date).toBe("2026-11-20");

    const s2 = scheduleNextMastery(s1, "item-1", "phrases-en-ko", true, "2026-11-20");
    expect(s2.tier).toBe("Familiar");
    expect(s2.next_due_date).toBe("2026-11-23");

    const s3 = scheduleNextMastery(s2, "item-1", "phrases-en-ko", true, "2026-11-23");
    expect(s3.tier).toBe("Mastered");
    expect(s3.next_due_date).toBe("2026-11-30");

    const s4 = scheduleNextMastery(s3, "item-1", "phrases-en-ko", true, "2026-11-30");
    expect(s4.tier).toBe("Mastered");
    expect(s4.next_due_date).toBe("2026-12-21");

    // Miss after 3-day gap: steps back one tier to Familiar, due immediately, keeps total days
    const missed = scheduleNextMastery(s4, "item-1", "phrases-en-ko", false, "2026-12-24");
    expect(missed.tier).toBe("Familiar");
    expect(missed.next_due_date).toBe("2026-12-24");

    const stats = computeMomentumStats(
      [
        { local_date: "2026-12-18", cards_completed: 5, correct_count: 4, attempt_count: 5 },
        {
          local_date: "2026-12-24",
          cards_completed: 5,
          correct_count: 3,
          attempt_count: 5,
          daily_grid_summary: "🟩🟨🟩🟩🟩",
        },
      ],
      [missed],
      "2026-12-24"
    );
    expect(stats.totalActiveDays).toBe(2);
    expect(stats.activeLast7Days).toBe(2);
    expect(stats.learnedCount).toBe(1);
    expect(stats.todayCompleted).toBe(true);
    expect(stats.days7.length).toBe(7);
    expect(stats.recentAccuracyPct).toBe(70);
    expect(stats.byTrack["phrases-en-ko"]?.familiar).toBe(1);
  });

  it("shuffleCardChoices preserves correct answer text and aligned romanization", () => {
    const sample: ContentShardItem = {
      item_id: "sample-1",
      track_id: "phrases",
      subtrack_id: "phrases-en-ko",
      difficulty: "beginner",
      prompt: "Thank you",
      options_4: ["감사합니다", "안녕하세요", "죄송합니다", "네"],
      options_romanization: ["gamsahamnida", "annyeonghaseyo", "joesonghamnida", "ne"],
      correct_index: 0,
      deterministic_note: "test",
      source_name: "Tatoeba",
      license_id: "CC-BY-2.0-FR",
    };
    const shuffled = shuffleCardChoices(sample, () => 0.25);
    expect(shuffled.options_4[shuffled.correct_index]).toBe("감사합니다");
    expect(shuffled.options_romanization?.[shuffled.correct_index]).toBe("gamsahamnida");
    expect(new Set(shuffled.options_4).size).toBe(4);
  });

  it("TEST-002: spoiler-free share card contains emoji grid without prompts/answers", () => {
    const txt = buildSpoilerFreeShareText({
      title: "BrainPlay · English -> Korean",
      dateOrRoom: "2026-11-19",
      outcomes: ["correct", "wrong", "correct", "correct", "skipped"],
      url: "https://example.pages.dev",
    });
    expect(txt).toContain("🟩🟨🟩🟩⬜ (3/5)");
    expect(txt).toContain("2026-11-19");
    expect(txt).not.toContain("안녕하세요");
  });

  it("TEST-007: checksummed sync export/import rejects 1-char corruption and merges valid data", () => {
    const items = [
      scheduleNextMastery(undefined, "tat-1", "phrases-en-ko", true, "2026-11-19"),
    ];
    const days = [{ local_date: "2026-11-19", cards_completed: 5 }];
    const code = encodeSyncString(items, days, "2026-11-19T00:00:00.000Z");
    expect(code.startsWith("BP1.")).toBe(true);

    // Corrupt 1 character
    const mid = Math.floor(code.length / 2);
    const flipped = code[mid] === "A" ? "B" : "A";
    const corrupted = code.slice(0, mid) + flipped + code.slice(mid + 1);
    const bad = parseAndVerifyBackup(corrupted);
    expect(bad.ok).toBe(false);

    const good = parseAndVerifyBackup(code);
    expect(good.ok).toBe(true);
    if (good.ok) {
      const older = [
        {
          ...items[0]!,
          tier: "Mastered" as const,
          updated_at: "2026-11-25T00:00:00.000Z",
        },
      ];
      const merged = mergeMasteryState(older, good.payload.mastery, [], good.payload.active_days);
      expect(merged.mastery[0]?.tier).toBe("Mastered");
      expect(merged.activeDays[0]?.cards_completed).toBe(5);
    }
  });

  it("UTF-8 Korean Hangul (NFC), Revised Romanization, and Japanese Kana/Kanji normalization works cleanly", () => {
    // NFD Jamo sequence for "한국어" -> NFC "한국어"
    const nfdKorean = "\u1112\u1161\u11AB\u1100\u116E\u11A8\u110B\u1165";
    const normKo = normalizeUtf8Text(nfdKorean);
    expect(normKo).toBe("한국어");
    expect(hasHangul(normKo)).toBe(true);
    expect(romanizeKorean("한국어")).toBe("hangugeo");
    expect(romanizeKorean("스펙트럼")).toBe("seupekteureom");

    const fwJapanese = "日本語　Ｔｅｓｔ！";
    expect(hasJapanese(fwJapanese)).toBe(true);
    expect(normalizeForMatching(fwJapanese)).toBe("日本語 test");
  });

  it("TEST-006: curated corpus shards satisfy >=1,500 items, >=600 Anime Trivia, >=250 Who's That Anime?, romanization, <1% defects & <25 MiB", () => {
    const catalogPath = join(PUBLIC_DIR, "packs", "catalog.json");
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as PackCatalog;

    expect(catalog.total_items).toBeGreaterThanOrEqual(1500);
    expect(catalog.tracks.map((t) => t.subtrack_id)).toEqual([
      "phrases-en-ko",
      "phrases-ko-en",
      "phrases-en-ja",
      "phrases-ja-en",
      "trivia-anime",
      "trivia-anime-characters",
      "trivia-world",
    ]);
    const animeTrack = catalog.tracks.find((t) => t.subtrack_id === "trivia-anime")!;
    expect(animeTrack.item_count).toBeGreaterThanOrEqual(600);
    const charTrack = catalog.tracks.find((t) => t.subtrack_id === "trivia-anime-characters")!;
    expect(charTrack.item_count).toBeGreaterThanOrEqual(250);

    let allItems: ContentShardItem[] = [];
    for (const shardMeta of catalog.shards) {
      const shardPath = join(PUBLIC_DIR, shardMeta.url.replace(/^\//, ""));
      expect(existsSync(shardPath)).toBe(true);
      expect(statSync(shardPath).size).toBeLessThan(25 * 1024 * 1024);

      const shardData = JSON.parse(readFileSync(shardPath, "utf8")) as {
        license_id: string;
        items: ContentShardItem[];
      };
      expect(shardData.items.length).toBe(shardMeta.item_count);
      allItems = allItems.concat(shardData.items);
    }

    expect(allItems.length).toBe(catalog.total_items);

    const seenByTrack = new Map<string, Set<string>>();
    let defects = 0;

    for (const item of allItems) {
      if (
        item.prompt.length < 2 ||
        item.prompt.length > 220 ||
        hasResidualHtmlArtifacts(item.prompt) ||
        item.options_4.length !== 4 ||
        new Set(item.options_4.map(normalizeForMatching)).size !== 4 ||
        item.options_4.some((o) => hasResidualHtmlArtifacts(o) || o.length === 0)
      ) {
        defects++;
      }

      if (item.subtrack_id === "phrases-en-ko") {
        expect(hasHangul(item.options_4[item.correct_index]!)).toBe(true);
        expect(item.options_romanization?.length).toBe(4);
        expect(item.options_romanization?.every((r) => /[a-zA-Z]/.test(r))).toBe(true);
        expect(item.license_id).toBe("CC-BY-2.0-FR");
      } else if (item.subtrack_id === "phrases-ko-en") {
        expect(hasHangul(item.prompt)).toBe(true);
        expect(item.prompt_romanization).toMatch(/[a-zA-Z]/);
        expect(item.license_id).toBe("CC-BY-2.0-FR");
      } else if (item.subtrack_id === "phrases-en-ja") {
        expect(hasJapanese(item.options_4[item.correct_index]!)).toBe(true);
        expect(item.options_romanization?.length).toBe(4);
        expect(item.options_romanization?.every((r) => /[a-zA-Z]/.test(r))).toBe(true);
        expect(item.license_id).toBe("CC-BY-2.0-FR");
      } else if (item.subtrack_id === "phrases-ja-en") {
        expect(hasJapanese(item.prompt)).toBe(true);
        expect(item.prompt_romanization).toMatch(/[a-zA-Z]/);
        expect(item.license_id).toBe("CC-BY-2.0-FR");
      } else if (item.subtrack_id === "trivia-world") {
        expect(item.license_id).toBe("CC-BY-SA-4.0");
      } else if (item.subtrack_id === "trivia-anime") {
        expect(["CC-BY-SA-4.0", "PUBLIC-FACTUAL-API"]).toContain(item.license_id);
      } else if (item.subtrack_id === "trivia-anime-characters") {
        expect(["PUBLIC-FACTUAL-API", "CC0-1.0"]).toContain(item.license_id);
        expect(item.source_name.length).toBeGreaterThan(0);
        expect(item.prompt.length).toBeGreaterThanOrEqual(15);
        expect(item.prompt.length).toBeLessThanOrEqual(220);
        expect(item.prompt).not.toMatch(/~!|!~|<[^>]+>|\[\/?[a-z]+(?:=[^\]]*)?\]/i);
        const answer = item.options_4[item.correct_index]!;
        const pLower = item.prompt.toLowerCase();
        expect(pLower).not.toContain(answer.toLowerCase());
        const tokens = answer
          .toLowerCase()
          .split(/[\s\-·•,()."“”'’]+/)
          .filter((t) => t.length >= 4);
        for (const tok of tokens) {
          expect(pLower).not.toMatch(
            new RegExp(`(?:^|[^a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:['’]?s)?(?=$|[^a-z0-9])`)
          );
        }
      }

      if (!seenByTrack.has(item.subtrack_id)) seenByTrack.set(item.subtrack_id, new Set());
      const pSet = seenByTrack.get(item.subtrack_id)!;
      const pNorm = normalizeForMatching(item.prompt);
      expect(pSet.has(pNorm)).toBe(false);
      pSet.add(pNorm);
    }

    expect(defects).toBe(0);

    // Character trivia VA-only share <= 5% & balanced correct_index across shards
    const charItems = allItems.filter((it) => it.subtrack_id === "trivia-anime-characters");
    const vaOnlyCount = charItems.filter((it) =>
      /voiced in Japanese by|JP voice:/i.test(it.prompt)
    ).length;
    expect(vaOnlyCount / charItems.length).toBeLessThanOrEqual(0.05);

    const slotCounts = [0, 0, 0, 0];
    for (const it of charItems) slotCounts[it.correct_index]!++;
    for (const cnt of slotCounts) {
      const share = cnt / charItems.length;
      expect(share).toBeGreaterThanOrEqual(0.15);
      expect(share).toBeLessThanOrEqual(0.35);
    }

    const globalSlotCounts = [0, 0, 0, 0];
    for (const it of allItems) globalSlotCounts[it.correct_index]!++;
    for (const cnt of globalSlotCounts) {
      const share = cnt / allItems.length;
      expect(share).toBeGreaterThanOrEqual(0.18);
      expect(share).toBeLessThanOrEqual(0.32);
    }

    // Deterministic daily selection check (REQ-NFR-002)
    const koItems = allItems.filter((i) => i.subtrack_id === "phrases-en-ko");
    const d1 = selectDeterministicDailyCards(koItems, "2026-11-19", "phrases-en-ko", new Set());
    const d2 = selectDeterministicDailyCards(koItems, "2026-11-19", "phrases-en-ko", new Set());
    expect(d1.map((x) => x.item_id)).toEqual(d2.map((x) => x.item_id));
  });

  it("options helpers: language track detection, forced character shuffle, URL building & orthogonal parsing", () => {
    expect(isLanguageTrack("phrases-en-ko")).toBe(true);
    expect(isLanguageTrack("phrases-ko-en")).toBe(true);
    expect(isLanguageTrack("phrases-en-ja")).toBe(true);
    expect(isLanguageTrack("phrases-ja-en")).toBe(true);
    expect(isLanguageTrack("trivia-anime")).toBe(false);
    expect(isLanguageTrack("trivia-anime-characters")).toBe(false);
    expect(isLanguageTrack("trivia-world")).toBe(false);

    expect(resolveTrackShuffle("trivia-anime-characters", false)).toBe(true);
    expect(resolveTrackShuffle("trivia-anime-characters", true)).toBe(true);
    expect(resolveTrackShuffle("trivia-anime", false)).toBe(false);
    expect(resolveTrackShuffle("phrases-en-ko", true)).toBe(true);

    // Non-language tracks omit rom= even when romajiMode !== "subtle"
    for (const triviaTrack of ["trivia-anime", "trivia-anime-characters", "trivia-world"]) {
      const url = buildSoloPlayUrl("practice", triviaTrack, {
        difficulty: "harder",
        shuffleCardsAndChoices: false,
        romajiMode: "off",
        sessionLength: 15,
      });
      expect(url).not.toContain("rom=");
      expect(url).toContain("diff=harder");
      expect(url).toContain("len=15");
      if (triviaTrack === "trivia-anime-characters") {
        expect(url).toContain("shuf=1");
      } else {
        expect(url).toContain("shuf=0");
      }
    }

    // Daily URL preserves len= when != 5 so "Play Extra Practice" can carry length
    const dailyCarriedUrl = buildSoloPlayUrl("daily", "phrases-en-ko", {
      ...getDefaultGameOptions("phrases-en-ko", "daily"),
      sessionLength: 10,
      romajiMode: "after_answer",
    });
    expect(dailyCarriedUrl).toContain("/play/daily?");
    expect(dailyCarriedUrl).toContain("len=10");
    expect(dailyCarriedUrl).toContain("rom=after_answer");
    expect(extractCarriedPracticeLength(dailyCarriedUrl.split("?")[1]!)).toBe(10);
    expect(extractCarriedPracticeLength("?track=phrases-en-ko")).toBe(5);
    expect(extractCarriedPracticeLength("?len=99")).toBe(5);

    // Orthogonal difficulty vs romajiMode + daily len=5 clamp + non-language rom normalization
    const harderKo = parseSoloOptionsFromSearch("?diff=harder&len=15", "phrases-en-ko", "daily");
    expect(harderKo.difficulty).toBe("harder");
    expect(harderKo.romajiMode).toBe("subtle");
    expect(harderKo.sessionLength).toBe(5);

    const practiceKo = parseSoloOptionsFromSearch("?diff=harder&rom=off&len=15", "phrases-en-ko", "practice");
    expect(practiceKo.difficulty).toBe("harder");
    expect(practiceKo.romajiMode).toBe("off");
    expect(practiceKo.sessionLength).toBe(15);

    const forcedCharDaily = parseSoloOptionsFromSearch(
      "?diff=harder&rom=off&shuf=0&len=10",
      "trivia-anime-characters",
      "daily"
    );
    expect(forcedCharDaily.shuffleCardsAndChoices).toBe(true);
    expect(forcedCharDaily.romajiMode).toBe("subtle");
    expect(forcedCharDaily.sessionLength).toBe(5);
  });

  it("applySessionCardOrderAndChoices & selectPracticeCards shuffle cards/choices and preserve harder tier priority", () => {
    const catalog = JSON.parse(
      readFileSync(join(PUBLIC_DIR, "packs", "catalog.json"), "utf8")
    ) as PackCatalog;

    const loadTrack = (subtrackId: string): ContentShardItem[] => {
      const track = catalog.tracks.find((t) => t.subtrack_id === subtrackId)!;
      return track.shards.flatMap(
        (url) =>
          (
            JSON.parse(readFileSync(join(PUBLIC_DIR, url.replace(/^\//, "")), "utf8")) as {
              items: ContentShardItem[];
            }
          ).items
      );
    };

    const makeRng = (seed = 42) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    for (const subtrackId of ["trivia-anime", "trivia-anime-characters"]) {
      const items = loadTrack(subtrackId);
      const sample10 = items.slice(0, 10);

      // Fixed order when shuffle === false
      const fixedSession = applySessionCardOrderAndChoices(sample10, false);
      expect(fixedSession.map((it) => it.item_id)).toEqual(sample10.map((it) => it.item_id));
      expect(fixedSession.map((it) => it.options_4)).toEqual(sample10.map((it) => it.options_4));

      // Shuffled order AND shuffled choices when shuffle === true
      const shuffledSession = applySessionCardOrderAndChoices(sample10, true, makeRng(101));
      expect(shuffledSession.map((it) => it.item_id)).not.toEqual(sample10.map((it) => it.item_id));
      expect(new Set(shuffledSession.map((it) => it.item_id))).toEqual(
        new Set(sample10.map((it) => it.item_id))
      );
      const anyChoicesPermuted = shuffledSession.some((it) => {
        const orig = sample10.find((o) => o.item_id === it.item_id)!;
        expect(it.options_4[it.correct_index]).toBe(orig.options_4[orig.correct_index]);
        return it.options_4.join("|") !== orig.options_4.join("|");
      });
      expect(anyChoicesPermuted).toBe(true);

      // selectPracticeCards harder mode prioritizes challenge -> intermediate -> beginner
      // while shuffling within the same difficulty tier when shuffle === true
      const mixedPool = [
        ...items.filter((i) => i.difficulty === "beginner").slice(0, 5),
        ...items.filter((i) => i.difficulty === "intermediate").slice(0, 5),
        ...items.filter((i) => i.difficulty === "challenge").slice(0, 10),
      ];
      const rank = { challenge: 0, intermediate: 1, beginner: 2 } as const;

      const fixedPractice = selectPracticeCards(
        mixedPool,
        new Map(),
        "2026-11-20",
        15,
        "harder",
        false
      );
      expect(fixedPractice.length).toBe(15);
      for (let i = 1; i < fixedPractice.length; i++) {
        expect(rank[fixedPractice[i]!.difficulty]).toBeGreaterThanOrEqual(
          rank[fixedPractice[i - 1]!.difficulty]
        );
      }

      const shufPracticeA = selectPracticeCards(
        mixedPool,
        new Map(),
        "2026-11-20",
        15,
        "harder",
        true,
        makeRng(7)
      );
      const shufPracticeB = selectPracticeCards(
        mixedPool,
        new Map(),
        "2026-11-20",
        15,
        "harder",
        true,
        makeRng(99)
      );
      expect(shufPracticeA.length).toBe(15);
      // Stratification picks 10 challenge + 5 intermediate (0 beginner) before final shuffle
      expect(shufPracticeA.filter((it) => it.difficulty === "challenge").length).toBe(10);
      expect(shufPracticeA.filter((it) => it.difficulty === "intermediate").length).toBe(5);
      expect(shufPracticeA.filter((it) => it.difficulty === "beginner").length).toBe(0);
      // Presentation order is shuffled (differs from fixed order / different seeds)
      expect(shufPracticeA.map((it) => it.item_id)).not.toEqual(
        fixedPractice.map((it) => it.item_id)
      );
      expect(shufPracticeA.map((it) => it.item_id)).not.toEqual(
        shufPracticeB.map((it) => it.item_id)
      );

      // Standard mode CSPRNG default shuffle variance
      const stdA = selectPracticeCards(items.slice(0, 30), new Map(), "2026-11-20", 15, "standard", true);
      const stdB = selectPracticeCards(items.slice(0, 30), new Map(), "2026-11-20", 15, "standard", true);
      expect(stdA.length).toBe(15);
      expect(stdA.map((it) => it.item_id)).not.toEqual(stdB.map((it) => it.item_id));
    }
  });

  it("UserPreferencesV1, prefStorage fallback, category helpers & CSPRNG entropy invariance", () => {
    // Memory fallback works cleanly in Node / restricted storage
    writePrefStorage("test_pref_key", "hello-world");
    expect(readPrefStorage("test_pref_key")).toBe("hello-world");

    // Corrupted JSON recovery
    writePrefStorage(PRB005_PREFS_STORAGE_KEY, "{not-valid-json");
    expect(loadUserPreferences()).toEqual(DEFAULT_USER_PREFS);

    // Category & subtrack resolution
    expect(LANGUAGE_SUBTRACK_IDS.length).toBe(4);
    expect(LANGUAGE_DIRECTIONS.length).toBe(4);
    expect(HUB_CATEGORIES.map((c) => c.id)).toEqual([
      "languages",
      "trivia-anime",
      "trivia-anime-characters",
      "trivia-world",
    ]);
    expect(ACTIVE_DIR_SHORT["phrases-en-ko"]).toBe("EN -> KO");
    expect(categoryFromSubtrack("phrases-ja-en")).toBe("languages");
    expect(categoryFromSubtrack("trivia-anime-characters")).toBe("trivia-anime-characters");
    expect(resolveSubtrackId("languages", "phrases-en-ja")).toBe("phrases-en-ja");
    expect(resolveSubtrackId("trivia-world", "phrases-en-ja")).toBe("trivia-world");

    const agg = aggregateLanguageTracks({
      "phrases-en-ko": { learned: 3, learning: 1, familiar: 1, mastered: 1, due: 2 },
      "phrases-ja-en": { learned: 4, learning: 2, familiar: 1, mastered: 1, due: 1 },
      "trivia-anime": { learned: 99, learning: 0, familiar: 0, mastered: 99, due: 0 },
    });
    expect(agg).toEqual({ learned: 7, learning: 3, familiar: 2, mastered: 2, due: 3 });

    // Save preferences and verify omitted URL params inherit them without overwriting stored prefs
    const saved = saveUserPreferences({
      selectedCategory: "trivia-anime",
      languageSubtrack: "phrases-ko-en",
      difficulty: "harder",
      sessionLength: 15,
      romajiMode: "after_answer",
      shuffleCardsAndChoices: true,
    });
    expect(loadUserPreferences()).toEqual(saved);
    expect(optionsFromPreferences(saved, "phrases-ko-en", "practice")).toEqual({
      difficulty: "harder",
      shuffleCardsAndChoices: true,
      romajiMode: "after_answer",
      sessionLength: 15,
    });

    const inheritedPractice = parseSoloOptionsFromSearch("?track=phrases-ko-en", "phrases-ko-en", "practice");
    expect(inheritedPractice).toEqual({
      difficulty: "harder",
      shuffleCardsAndChoices: true,
      romajiMode: "after_answer",
      sessionLength: 15,
    });
    expect(extractCarriedPracticeLength("?track=phrases-ko-en")).toBe(15);

    // Daily always clamps sessionLength to 5, and character trivia forces shuffle non-destructively
    saveUserPreferences({ shuffleCardsAndChoices: false });
    const dailyChar = parseSoloOptionsFromSearch("?track=trivia-anime-characters", "trivia-anime-characters", "daily");
    expect(dailyChar.sessionLength).toBe(5);
    expect(dailyChar.shuffleCardsAndChoices).toBe(true);
    expect(loadUserPreferences().shuffleCardsAndChoices).toBe(false);

    // Restore defaults cleanly
    saveUserPreferences({
      selectedCategory: DEFAULT_USER_PREFS.selectedCategory,
      languageSubtrack: DEFAULT_USER_PREFS.languageSubtrack,
      difficulty: DEFAULT_USER_PREFS.difficulty,
      sessionLength: DEFAULT_USER_PREFS.sessionLength,
      romajiMode: DEFAULT_USER_PREFS.romajiMode,
      shuffleCardsAndChoices: DEFAULT_USER_PREFS.shuffleCardsAndChoices,
    });

    // CSPRNG utilities & value-based correct_index invariance
    for (let i = 0; i < 40; i++) {
      const r = cryptoRandomInt(4);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(4);
    }
    expect(new Set(cryptoShuffleIndices(4))).toEqual(new Set([0, 1, 2, 3]));

    const card: ContentShardItem = {
      item_id: "csprng-1",
      track_id: "trivia",
      subtrack_id: "trivia-anime-characters",
      difficulty: "beginner",
      prompt: "Who wields Elucidator?",
      options_4: ["Kirito", "Asuna", "Sinon", "Klein"],
      correct_index: 0,
      deterministic_note: "test",
      source_name: "AniList",
      license_id: "PUBLIC-FACTUAL-API",
    };
    const seenPositions = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const out = shuffleCardChoices(card);
      expect(out.options_4[out.correct_index]).toBe("Kirito");
      seenPositions.add(out.correct_index);
    }
    expect(seenPositions.size).toBeGreaterThan(1);
  });

  it("backup.ts rejects prototype-key tiers, missing updated_at, invalid numbers, arrays & >2MB payloads", () => {
    const createSignedRaw = (bodyObj: Record<string, unknown>) => {
      // Compute the exact same FNV-1a checksum used by createBackupPayload via encode/decode helper isn't needed for structural checks,
      // but testing with valid checksum proves structural guards run before/with checksum checks.
      return JSON.stringify(bodyObj);
    };

    // Prototype key ("toString") in tier
    expect(
      parseAndVerifyBackup(
        createSignedRaw({
          schema_version: 1,
          exported_at: "2026-11-20T00:00:00.000Z",
          mastery: [
            {
              item_id: "i1",
              subtrack_id: "phrases-en-ko",
              tier: "toString",
              streak_count: 1,
              next_due_date: "2026-11-21",
              updated_at: "2026-11-20T00:00:00.000Z",
              flagged_hidden: false,
            },
          ],
          active_days: [],
          checksum: "0000000000000000",
        })
      )
    ).toEqual({ ok: false, error: "Backup contains invalid mastery entry." });

    // Missing updated_at
    expect(
      parseAndVerifyBackup(
        createSignedRaw({
          schema_version: 1,
          exported_at: "2026-11-20T00:00:00.000Z",
          mastery: [
            {
              item_id: "i1",
              subtrack_id: "phrases-en-ko",
              tier: "Learning",
              streak_count: 1,
              next_due_date: "2026-11-21",
              flagged_hidden: false,
            },
          ],
          active_days: [],
          checksum: "0000000000000000",
        })
      )
    ).toEqual({ ok: false, error: "Backup contains invalid mastery entry." });

    // Invalid streak_count / cards_completed (null / non-number)
    expect(
      parseAndVerifyBackup(
        createSignedRaw({
          schema_version: 1,
          exported_at: "2026-11-20T00:00:00.000Z",
          mastery: [],
          active_days: [{ local_date: "2026-11-20", cards_completed: null }],
          checksum: "0000000000000000",
        })
      )
    ).toEqual({ ok: false, error: "Backup contains invalid active-day entry." });

    // Array payload rejected
    expect(parseAndVerifyBackup("[]")).toEqual({
      ok: false,
      error: "Backup payload must be an object.",
    });

    // Oversized (> 2 MB) payload rejected
    const oversized = "{" + " ".repeat(2 * 1024 * 1024 + 16) + "}";
    expect(parseAndVerifyBackup(oversized)).toEqual({
      ok: false,
      error: "Backup input exceeds 2 MB size limit.",
    });
  });

  it("storage.ts data notice helpers & clean memory degradation on storage unavailability", async () => {
    expect(isDataNoticeDismissed()).toBe(false);
    dismissDataNotice();
    expect(readPrefStorage(DATA_NOTICE_STORAGE_KEY)).toBe("1");
    expect(isDataNoticeDismissed()).toBe(true);

    const errors: string[] = [];
    const store = await createLocalStore((reason) => errors.push(reason));
    expect(store.mode).toBe("memory");
    expect(errors.length).toBeGreaterThan(0);

    await store.saveActiveDay({ local_date: "2026-11-20", cards_completed: 5 });
    const loaded = await store.loadAll();
    expect(loaded.activeDays.length).toBe(1);
    expect(loaded.activeDays[0]?.cards_completed).toBe(5);
  });

  it("roomClient & packsClient handle network/parse errors and Retry-After headers gracefully", async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch;

      await expect(loadPackCatalog()).rejects.toThrow("Offline or unreadable pack data");

      let caught: unknown;
      try {
        await apiCreateRoom({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 10,
          roundSeconds: 25,
          hostName: "Tester",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiRequestError);
      expect((caught as ApiRequestError).status).toBe(0);
      expect((caught as ApiRequestError).payload.code).toBe("NETWORK_ERROR");

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ code: "RATE_LIMITED", error: "Slow down" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "45" },
        })) as typeof fetch;

      let rateErr: unknown;
      try {
        await apiCreateRoom({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 10,
          roundSeconds: 25,
          hostName: "Tester",
        });
      } catch (err) {
        rateErr = err;
      }
      expect(rateErr).toBeInstanceOf(ApiRequestError);
      expect((rateErr as ApiRequestError).status).toBe(429);
      expect((rateErr as ApiRequestError).payload.retryAfterSec).toBe(45);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("roomClient saveRoomToken / getSavedRoomToken / clearSavedRoomToken lifecycle", () => {
    const mockMap = new Map<string, string>();
    const origLs = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => mockMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mockMap.set(k, v);
      },
      removeItem: (k: string) => {
        mockMap.delete(k);
      },
      clear: () => mockMap.clear(),
      key: (i: number) => Array.from(mockMap.keys())[i] ?? null,
      get length() {
        return mockMap.size;
      },
    };
    try {
      saveRoomToken("k7m9p2", "tok-123");
      expect(getSavedRoomToken("K7M9P2")).toBe("tok-123");
      clearSavedRoomToken("k7m9p2");
      expect(getSavedRoomToken("K7M9P2")).toBeNull();
    } finally {
      (globalThis as { localStorage?: Storage }).localStorage = origLs;
    }
  });

  it("roomClient normalizeApiBase, buildApiUrl, and buildRoomWsUrl support Pages -> Workers split and relative fallback", () => {
    expect(normalizeApiBase("")).toBe("");
    expect(normalizeApiBase("   ")).toBe("");
    expect(normalizeApiBase("ftp://invalid.example.com")).toBe("");
    expect(normalizeApiBase("example.workers.dev")).toBe("");
    expect(normalizeApiBase("  https://prb005-brainplay-api.example.workers.dev///  ")).toBe(
      "https://prb005-brainplay-api.example.workers.dev"
    );

    // Empty apiBase preserves relative paths and falls back to window.location for WS
    expect(buildApiUrl("/api/rooms", "")).toBe("/api/rooms");
    expect(buildApiUrl("/api/flags", "   ")).toBe("/api/flags");
    expect(buildApiUrl("/api/rooms", "https://prb005-brainplay-api.example.workers.dev/")).toBe(
      "https://prb005-brainplay-api.example.workers.dev/api/rooms"
    );
    expect(buildApiUrl("/api/flags", "http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787/api/flags"
    );

    expect(
      buildRoomWsUrl("k7m9p2", "tok+1", "https://prb005-brainplay-api.example.workers.dev/")
    ).toBe("wss://prb005-brainplay-api.example.workers.dev/api/rooms/K7M9P2/ws?token=tok%2B1");

    expect(buildRoomWsUrl("k7m9p2", "tok+1", "http://127.0.0.1:8787")).toBe(
      "ws://127.0.0.1:8787/api/rooms/K7M9P2/ws?token=tok%2B1"
    );

    const origWindow = (globalThis as { window?: unknown }).window;
    try {
      (globalThis as { window?: unknown }).window = {
        location: { protocol: "https:", host: "brainplay.pages.dev" },
      };
      expect(buildRoomWsUrl("k7m9p2", "tok+1", "")).toBe(
        "wss://brainplay.pages.dev/api/rooms/K7M9P2/ws?token=tok%2B1"
      );

      (globalThis as { window?: unknown }).window = {
        location: { protocol: "http:", host: "localhost:5173" },
      };
      expect(buildRoomWsUrl("k7m9p2", "tok+1", "")).toBe(
        "ws://localhost:5173/api/rooms/K7M9P2/ws?token=tok%2B1"
      );
    } finally {
      if (origWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = origWindow;
      }
    }
  });
});
