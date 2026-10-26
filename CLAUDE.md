# Fantasy Trade Desk — project rules

Read-only Yahoo Fantasy Football assistant: values players under the league's
scoring, suggests trades, waiver moves and breakout targets. Overview in
README.md; design spec and API contract in docs/DESIGN.md (later sections
override earlier ones: "Amendments", "Trade finder v2", "v3", "Breakout Targets").
Open work and "Resume here" live in TASKS.md.

## Repo
- GitHub: `Rai097/FantasyFootball` (owner account Rai097; collaborator gwu0097 pushes).
- Working branch and default: `claude/sleepy-tesla-633nk6`. No `main` yet.
- Owner's league: Yahoo league id 1405188, 12 teams, H2H redraft, weeks 1–14,
  playoffs 15–17, rolling-list waivers (Tuesdays), trade deadline 2026-11-28.

## Commands
- `npm ci` — install (Node 22+).
- `npm run dev` — server :3000 + Vite UI :5173.
- `npm run typecheck` — strict TS for server and web.
- `npm test` — node:test via tsx over `server/**/*.test.ts` (unit + integration on the demo league).
- `npm run build && npm start` — production build served on :3000.
- `npm run yahoo:probe` — probe the Yahoo API from another network.

## Layout
- `server/data` public data loaders (nflverse, ffopportunity, DynastyProcess, FantasyCalc), cached in `.cache/`.
- `server/model` pure engine: scoring, projection, lineup, analysis, trades (v1/v2/v3), waivers, breakouts. Each module has a sibling `.test.ts`.
- `server/providers` league sources: `demo`, `yahoo` (OAuth API), `import` (pasted Yahoo web pages / bookmarklet).
- `server/api.ts` HTTP API — the web app depends on the contract in docs/DESIGN.md.
- `web/src` React 18 + Vite, plain CSS, tabs in `web/src/tabs`.

## Rules
- Read-only toward Yahoo: never add a write call.
- Every number shown in the UI has a one-sentence "why" tooltip.
- Never commit `.env`, `.cache/`, `.data/` (already in .gitignore).
- Yahoo API access is pending Yahoo's approval (since July 2026 apps need it); until then
  the `import` provider is the real-league path. Yahoo code must stay defensive and
  log the raw response on parse failure.
- Mobile: check 390 px and 1280 px; screenshots live in `docs/screenshots/`.

## Deploy
- Render blueprint `render.yaml`: service `fantasy-trade-desk`, free plan, Oregon (US region
  required by Yahoo), health check `/healthz`, password gate via `APP_PASSWORD`. Guide: docs/DEPLOY.md.
- UNVERIFIED: whether Render auto-deploys on push to the working branch. Until confirmed,
  assume a push may deploy. Claude has no standing grant to trigger or change Render deploys — ask.
