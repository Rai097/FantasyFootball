// npm run yahoo:login — STOPGAP until the Yahoo API is approved (docs/DESIGN.md "Auto-import (stopgap until Yahoo
// API)"). Opens HEADED system Google Chrome on the auto-import's dedicated profile at the league page so the owner
// signs in to Yahoo THEMSELVES; it exits when the window is closed. No login automation; it never reads the profile's
// cookies. Run it on the server Mac from the release worktree (profile ~/FantasyFootball-run/.data/yahoo-chrome-profile)
// while no auto-import run is in progress (Chrome locks a profile to one process).
// Docs: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
import fs from "node:fs";
import { chromium } from "playwright-core";
import { leagueUrl } from "../server/autoimport/collector.js";
import { defaultProfileDir } from "../server/autoimport/service.js";

const profileDir = (process.env.AUTO_IMPORT_PROFILE ?? "").trim() || defaultProfileDir();
const leagueId = (process.env.AUTO_IMPORT_LEAGUE_ID ?? process.argv[2] ?? "").trim();
if (!/^\d{1,12}$/.test(leagueId)) {
  console.error("Usage: AUTO_IMPORT_LEAGUE_ID=<yahoo league number> npm run yahoo:login   (or: npm run yahoo:login -- <number>)");
  process.exit(2);
}
fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
console.log(`Opening Chrome on ${profileDir}. Sign in to Yahoo in that window, check your league shows, then close the window.`);
const ctx = await chromium.launchPersistentContext(profileDir, { channel: "chrome", headless: false, viewport: null });
const closed = new Promise<void>((r) => ctx.on("close", () => r()));
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(leagueUrl(leagueId)).catch(() => undefined);
await closed;
console.log("Chrome closed. The auto-import will use this profile on its next run.");
