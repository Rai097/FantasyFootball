# Fantasy Trade Desk — project rules

Read-only Yahoo Fantasy Football assistant: values players under the league's
scoring, suggests trades, waiver moves and breakout targets. Overview in
README.md; design spec and API contract in docs/DESIGN.md (later sections
override earlier ones: "Amendments", "Trade finder v2", "v3", "Breakout Targets").
Open work and "Resume here" live in TASKS.md.

## Repo
- GitHub: `Rai097/FantasyFootball` (owner account Rai097; collaborator gwu0097 pushes).
- Working branch and default: `claude/sleepy-tesla-633nk6`. No `main` yet.
- Owner's league: Yahoo league id 1405188, 12 teams, H2H redraft, full PPR, weeks 1–14,
  playoffs 15–17 (6 teams), rolling-list waivers processed ~Wednesday early morning PT
  (2-day clock on drops), trade deadline 2026-11-28.
- Custom kicker scoring: 50–59 yd FG = 4, 60+ = 5. Lineup QB, 2 WR, RB, TE, 2 W/R/T, K, DEF, 6 BN, 2 IR.
- The repo is PUBLIC: never commit other managers' names, the owner's roster plans or trade notes.

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
- Render service `srv-dau493jncjis73amrrvg` (workspace "My Workspace", account guanwu097),
  https://fantasy-trade-desk.onrender.com. AUTO-DEPLOYS on every push to the working branch,
  so a push = a production deploy and wipes `.data/` (browser backup restores imports).
  Batch docs-only commits with a code change; ask before pushing. Imported league data lives
  only on the server disk and in the browser's localStorage — not in git, not readable via Render MCP.
- A claude.ai/code cloud session may also push to this branch: `git fetch` before starting work.
- Mac mini (primary since 2026-10-26): https://ff.raibot.us → Cloudflare tunnel `raibot-dashboard`
  (~/.cloudflared/config.yml, shared with dashboard/perp.raibot.us) → launchd `com.fantasy.tradedesk` on 127.0.0.1:5070,
  running the release worktree ~/FantasyFootball-run (detached at the release commit; template
  scripts/com.fantasy.tradedesk.plist). Data persists in ~/FantasyFootball-run/.data; log ~/FantasyFootball-run/server.log.
  No password: APP_PUBLIC=1 (owner's choice until Discord login).
- Mac deploy: `git -C ~/FantasyFootball-run checkout --detach <commit>` (+ `npm ci && npm run build` there when
  dependencies or web/ changed), then `launchctl kickstart -k gui/$(id -u)/com.fantasy.tradedesk`; smoke-check the log
  and one real request on https://ff.raibot.us. Restarting the shared tunnel needs the owner's OK (it blips perp.raibot.us).
