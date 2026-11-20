# Deploying Zero-Cost Social Casual Learning (BrainPlay)

Production deployment guide for the zero-cost Cloudflare stack (Pages + Workers + Durable Objects + D1).

## Pre-Deploy Verification

```bash
npm ci
npm run typecheck
npm run test:unit
npm run test:worker
npm run build
npm run check:bundle
npm run test:e2e
```

## 1. Authenticate Wrangler

```bash
npx wrangler login
```

## 2. Provision D1 Database & Apply Append-Only Migrations

```bash
npx wrangler d1 create prb005-brainplay-db
```

Copy the returned `database_id` into `wrangler.jsonc` (replacing the `00000000-0000-0000-0000-000000000000` placeholder under `d1_databases`), then apply migrations remotely:

```bash
npx wrangler d1 migrations apply prb005-brainplay-db --remote
```

> **Migration Safety:** Never modify an already-deployed migration file (such as `worker/migrations/0001_init.sql`). Always add a new sequential file (`0002_<name>.sql`, etc.).

## 3. Configure Signing Secret

Generate a 32+ character random secret and upload it as a Worker secret (never commit `.dev.vars` or secrets):

```bash
npx wrangler secret put ROOM_TOKEN_SECRET
```

## 4. Deploy Worker & Durable Object (`RoomActor`)

```bash
npx wrangler deploy
```

This deploys the `prb005-brainplay-api` Worker (`worker/src/index.ts`) with the SQLite-backed `RoomActor` Durable Object (`v1` migration) and free-tier quota guardrails (`DAILY_REQUEST_HARD_CAP=100000`, `DAILY_WRITE_HARD_CAP=100000`, `QUOTA_SHED_RATIO=0.85`).

> **API Origin Routing (`VITE_API_BASE` vs. Same-Origin):** `src/core/roomClient.ts` routes `/api/*` and WebSocket upgrades to `VITE_API_BASE` when set at build time, or falls back to relative `/api/*` on `window.location.host` when omitted. Solo Daily & Practice modes operate purely from static Pages assets even without `/api/*`.

## 5. Deploy Static Frontend (`dist/`) to Cloudflare Pages & Lock `ALLOWED_ORIGIN`

For split Cloudflare Pages + Worker hosting, build with `VITE_API_BASE` pointing to your deployed Worker URL, verify the bundle budget, and deploy to Pages:

```bash
VITE_API_BASE=https://<worker>.workers.dev npm run build
npm run check:bundle
npx wrangler pages project create prb005-brainplay
npx wrangler pages deploy dist --project-name=prb005-brainplay
```

*(If serving Pages and the Worker `/api/*` route on the same custom domain, omit `VITE_API_BASE` during `npm run build`.)*

After the first Pages deploy succeeds, lock `ALLOWED_ORIGIN` in `wrangler.jsonc` from `"*"` to the live `https://*.pages.dev` origin (for example `https://prb005-brainplay.pages.dev`) and redeploy the Worker:

```bash
npx wrangler deploy
```

`public/_headers` configures security headers and asset caching for Cloudflare Pages.

> **PWA Cache Note:** Whenever `public/sw.js` changes, bump `CACHE_NAME` in `public/sw.js` so offline clients refresh their shell cache.

## 6. Post-Deploy Smoke Checks & Rollback

1. Verify `GET /api/health` (`{"ok":true,"service":"prb005-edge-router"}`) and `GET /api/quota` return `200 OK`.
2. Open Solo Daily mode and confirm zero `/api/` network requests occur.
3. Create and join a 2-player Live room to confirm WebSocket sync works end to end.
4. Rollback if needed:
   - Worker: `npx wrangler rollback`
   - Pages: promote the previous deployment in the Cloudflare Pages dashboard

## 7. Future `/fix` Update Flow (Export -> Branch -> PR -> CI -> Merge -> Deploy)

1. **Sync & Verify Safety Invariants:** Export verified updates into this standalone repository while preserving existing `.git/` history, deployed `database_id`, and `ALLOWED_ORIGIN` in `wrangler.jsonc`.
   - Keep D1 migrations append-only (`worker/migrations/0002_<name>.sql`; never edit deployed `0001_init.sql`).
   - Preserve `BP1.` backup/restore compatibility and bump `CACHE_NAME` in `public/sw.js` whenever `public/sw.js` changes.
2. **Branch & Commit:** Create a feature/fix branch from `main` and commit with `user.name = yatoyataro` and **zero** AI `Co-authored-by` trailers.
3. **Open PR & Verify CI:** Push the branch and open a pull request, then confirm `.github/workflows/ci.yml` (`typecheck`, `test:unit`, `test:worker`, `build`, `check:bundle`) passes:
   ```bash
   gh pr create --fill
   gh pr checks --watch
   ```
4. **Merge Cleanly:** Once CI is green, merge via:
   ```bash
   gh pr merge --squash --delete-branch
   ```
5. **Apply Migrations & Deploy:** On `main`, apply any new D1 migrations (`npx wrangler d1 migrations apply prb005-brainplay-db --remote`), rebuild Pages with `VITE_API_BASE=https://<worker>.workers.dev npm run build` + `npm run check:bundle`, deploy Pages (`npx wrangler pages deploy dist --project-name=prb005-brainplay`), redeploy Worker (`npx wrangler deploy`) keeping `database_id` and `ALLOWED_ORIGIN` synced, and re-run Section 6 smoke checks.
