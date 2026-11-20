# Third-Party Notices & Corpus Licensing Separation

## 1. License Boundary: Application Code vs. Corpus Datasets

BrainPlay separates its original software implementation from bundled third-party open learning datasets and build-time derived corpus indexes:

### MIT-Licensed Original Software (`LICENSE`)
Copyright (c) 2026 Dwight Jairo Pingul ([@yatoyataro](https://github.com/yatoyataro))

The [MIT License](LICENSE) applies to all original BrainPlay application, CLI, Worker, test, and configuration source code:
- `src/` — Preact SPA frontend, local storage/mastery engine, and UI components
- `worker/src/` (excluding `worker/src/generated/`) — Cloudflare Worker edge router, `RoomActor` Durable Object, D1 quota/flag helpers, and auth/sanitization modules
- `worker/migrations/` — D1 SQL schema migrations
- `packages/corpus-cli/src/` — Offline corpus ingestion, curation, and romanization CLI
- `scripts/` — Build/bundle verification scripts (`check-bundle.mjs`)
- `tests/` — Unit, Worker, and Playwright E2E test suites
- `public/sw.js`, `public/manifest.webmanifest`, `public/_headers`, `index.html`

### Third-Party Datasets & Derived Corpus Artifacts
All bundled static learning packs, daily manifests, and generated Worker lookup tables remain governed by their respective upstream open licenses and attribution terms, isolated from the MIT-licensed codebase:
- `public/packs/` — `catalog.json` and license-partitioned modular JSON shards (`cc-by-2.0-fr/`, `cc-by-sa-4.0/`, `public-factual-api/`)
- `public/data/daily/` — `210` static daily JSON manifests (`7` subtracks &times; `30` dates, `2026-11-19` through `2026-12-18`)
- `worker/src/generated/` — Build-time derived `serverAnswerIndex.json` (`4,058` entries) and `subtrackItemIds.json` (`7` subtracks), generated from the same corpus items and preserving per-item `source_name` and `license_id` metadata

---

## 2. Bundled Open Learning Corpora (Verified against `public/packs/catalog.json`)

**Current Static Bundle Totals:** `4,058` verified 4-choice cards across `31` modular JSON shards and `7` subtracks.

| Upstream Source | Directory | License (`license_id`) | Shards | Items | Subtracks Covered | Attribution & Isolation Notes |
| --- | --- | --- | ---: | ---: | --- | --- |
| **Tatoeba Project** (`https://tatoeba.org/`) | `public/packs/cc-by-2.0-fr/` | **CC BY 2.0 FR** (`CC-BY-2.0-FR`, `https://creativecommons.org/licenses/by/2.0/fr/`) | 12 | 1,440 | `phrases-en-ko` (360), `phrases-ko-en` (360), `phrases-en-ja` (360), `phrases-ja-en` (360) | `3` shards per language pair. Pre-computed Korean Revised Romanization and Japanese Hepburn Romaji. Per-item `source_author` preserved on all `1,440` items. |
| **OpenTriviaDB** (`https://opentdb.com/`) | `public/packs/cc-by-sa-4.0/` | **CC BY-SA 4.0** (`CC-BY-SA-4.0`, `https://creativecommons.org/licenses/by-sa/4.0/`) | 4 | 556 | `trivia-anime` (147), `trivia-world` (409) | `1` shard in `trivia-anime` (Category 31); `3` shards in `trivia-world`. Derivative ShareAlike packs are strictly isolated under `public/packs/cc-by-sa-4.0/`. |
| **AniList & Kitsu** (`https://anilist.co/`, `https://kitsu.io/`) | `public/packs/public-factual-api/` | **PUBLIC-FACTUAL-API** | 15 | 2,062 | `trivia-anime` (1,508: 1,406 AniList + 102 Kitsu), `trivia-anime-characters` (554: AniList) | `11` shards in `trivia-anime`; `4` shards in `trivia-anime-characters`. Offline build-time factual metadata curation only; zero runtime API calls. |
| **CC0 Schema Support** | *(schema-supported)* | **CC0 1.0** (`CC0-1.0`) | 0 | 0 | *(none active)* | `CC0-1.0` is supported in the TypeScript schema (`src/core/types.ts`, `worker/src/roomActor.ts`) and ingestion pipeline (`REQ-NFR-007`); `0` active `CC0-1.0` shards are in the current bundle. |
| **Total** | `public/packs/` | — | **31** | **4,058** | **7 subtracks** | Verified against `public/packs/catalog.json` (`generated_at: 2026-11-19T17:13:05.390Z`). |

> **Note on `trivia-anime` mixed sources:** `public/packs/catalog.json` stores one summary `license_id` per track entry, while individual shards and items in `trivia-anime` carry exact per-shard/per-item `license_id` values (`1` `CC-BY-SA-4.0` shard with `147` items from OpenTriviaDB + `11` `PUBLIC-FACTUAL-API` shards with `1,508` items from AniList and Kitsu, totaling `1,655` items across `12` shards).

---

## 3. Third-Party Software Dependencies

- **Preact** (`preact`, runtime dependency in `package.json`) — **MIT License**, Copyright (c) 2015-present Jason Miller (`node_modules/preact/LICENSE`).
- Development, build, romanization, and test tooling declared in `package.json` (`devDependencies`: TypeScript, Vite, `@preact/preset-vite`, Vitest, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, Playwright, Wrangler, `kuroshiro`, `kuroshiro-analyzer-kuromoji`, `@types/node`) are used at build/test time only and are not redistributed as BrainPlay source code.
