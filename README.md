# BrainPlay

**Zero-cost, zero-account, zero-tracker casual daily & social learning game.**

Copyright (c) 2026 Dwight Jairo Pingul ([@yatoyataro](https://github.com/yatoyataro)) · Application code licensed under [MIT](LICENSE) · Bundled open learning datasets documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Overview & Verified Features

BrainPlay delivers 3–5 minute multiple-choice rounds across two tracks (`7` subtracks, `4,058` curated cards across `31` modular JSON shards, plus `30` pre-generated daily dates):

- **Track 1 — Phrases & Words in Context (`1,440` cards):**
  - `phrases-en-ko` (English &rarr; Korean, `360` cards)
  - `phrases-ko-en` (Korean &rarr; English, `360` cards)
  - `phrases-en-ja` (English &rarr; Japanese, `360` cards)
  - `phrases-ja-en` (Japanese &rarr; English, `360` cards)
  - Includes build-time Korean Revised Romanization and Japanese Hepburn Romaji (`subtle`, `after_answer`, or `off`).
- **Track 2 — Anime & World Trivia (`2,618` cards):**
  - `trivia-anime` (Anime Trivia, `1,655` cards)
  - `trivia-anime-characters` (Who's That Anime? Character Trivia, `554` cards)
  - `trivia-world` (World, Culture & Science Trivia, `409` cards)
- **Play Modes & Routes:**
  - `/` — Play Hub (track/subtrack selector, difficulty `standard`/`harder`, session length `5`/`10`/`15`, romaji & shuffle controls, momentum summary)
  - `/play/daily` — Daily Challenge (deterministic static daily manifests under `/data/daily/`)
  - `/play/practice` — Unlimited Solo Practice (local spaced-repetition prioritization & shareable emoji result grid)
  - `/room/new` & `/room/:code` — Optional 2–50 player Live or Async 24h multiplayer rooms
  - `/mastery` — Local Mastery & Streak Dashboard with portable `BP1.` backup/restore
  - `/about` — Zero-PII privacy details, MIT ownership notice, and per-corpus attribution (`AboutView.tsx`)

---

## `$0` & Zero-PII Architecture

- **Solo Mode (Daily & Practice) = `0` Worker / DO / D1 hits:**
  - Served strictly from static JSON shards (`/packs/*`) and static daily manifests (`/data/daily/*`) with offline PWA caching via `public/sw.js` (`CACHE_NAME = "prb005-brainplay-v6"`).
  - User preferences, mastery state, and active days stay locally in browser `IndexedDB` (`prb005-brainplay`, with `localStorage` and in-memory fallbacks).
- **Multiplayer Rooms = Free-Tier Guarded Edge Execution:**
  - **Cloudflare Worker (`worker/src/index.ts`):** Stateless edge router handling `/api/health`, `/api/quota`, `/api/rooms*`, and `/api/flags` with HMAC-signed room tokens (`ROOM_TOKEN_SECRET`) and origin checks (`ALLOWED_ORIGIN`).
  - **Single-Row Durable Object SQLite (`worker/src/roomActor.ts`):** `RoomActor` stores room state as a single JSON row in `room_state` (`id = 1`) and automatically expires/deletes rooms after **48 hours**.
  - **Cloudflare D1 (`worker/migrations/0001_init.sql`):** Stores only zero-PII aggregate counters (`CARD_FLAG_AGGREGATE`, `DAILY_QUOTA_COUNTER`, `IP_RATE_LIMIT`).
  - **Proactive Quota Shedding (`85%`):** When estimated daily DO requests or writes reach `QUOTA_SHED_RATIO` (`0.85` of `DAILY_REQUEST_HARD_CAP=100000` / `DAILY_WRITE_HARD_CAP=100000`), new room creation returns `503 DAILY_QUOTA_REACHED` with `fallback: "solo"` so Solo Daily & Practice remain uninterrupted.
- **Zero Runtime Third-Party APIs & Zero Trackers:** No user accounts, emails, analytics trackers, advertising cookies, or runtime calls to Tatoeba/OpenTriviaDB/AniList/Kitsu.

---

## Verified Commands

Run from the project root:

```bash
npm ci
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite local development server |
| `npm run typecheck` | Run TypeScript typechecking for client (`tsconfig.json`) and Worker (`worker/tsconfig.json`) |
| `npm run test:unit` | Run Vitest core unit tests (`tests/unit/core.test.ts`) |
| `npm run test:worker` | Run Cloudflare Workers Vitest pool tests (`tests/worker/room.worker.test.ts`) |
| `npm run build` | Build production static bundle into `dist/` |
| `npm run check:bundle` | Verify gzipped JS+CSS shell & chunks (`< 250 KB`) and per-file `< 25 MiB` Cloudflare Pages budget |
| `npm run test:e2e` | Run Playwright E2E browser tests (`tests/e2e/app.spec.ts`) |
| `npm run test:all` | Run `typecheck`, `test:unit`, `test:worker`, `build`, `check:bundle`, and `test:e2e` sequentially |
| `npm run corpus:build` | Rebuild static shards, `catalog.json`, `public/data/daily/`, and `worker/src/generated/` from `.cache/corpus/` |

For local Worker testing, copy `.dev.vars.example` to `.dev.vars` and set `ROOM_TOKEN_SECRET` (never commit `.dev.vars` or real secrets).

---

## Licensing & Attribution

- **Application Source Code:** [MIT License](LICENSE) — `Copyright (c) 2026 Dwight Jairo Pingul (@yatoyataro)` (`https://github.com/yatoyataro`).
- **Open Learning Corpora:** Separate upstream licenses (`CC BY 2.0 FR`, `CC BY-SA 4.0`, `PUBLIC-FACTUAL-API`, plus `CC0-1.0` schema support) — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the in-app `/about` view (`src/routes/AboutView.tsx`).
