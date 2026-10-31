// npm run yahoo:login — STOPGAP until the Yahoo API is approved (docs/DESIGN.md "Auto-import (stopgap until Yahoo
// API)"). Opens a PLAIN headed system Google Chrome on the auto-import's dedicated profile at the league page so the
// owner signs in to Yahoo THEMSELVES; it exits when that Chrome quits. No login automation; it never reads the
// profile's cookies. Run it on the server Mac from the release worktree (profile
// ~/FantasyFootball-run/.data/yahoo-chrome-profile) while no auto-import run is in progress (Chrome locks a profile to
// one process).
// Why not Playwright: a Playwright-launched Chrome is automation-controlled, and Google refuses "Sign in with Google"
// there ("This browser or app may not be secure"). The window gets Playwright's cookie-storage switches instead
// (--use-mock-keychain, --password-store=basic) so the headless runner, which Playwright launches with them, can read
// the sign-in; a sign-in saved under the real macOS Keychain is unreadable to it.
// Docs: https://developers.googleblog.com/2020/08/guidance-for-our-effort-to-block-less-secure-browser-and-apps.html
// (Google sign-in needs a browser with no automation), https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
import { spawn } from "node:child_process";
import fs from "node:fs";
import { leagueUrl } from "../server/autoimport/collector.js";
import { defaultProfileDir } from "../server/autoimport/service.js";

const chromePath = (process.env.CHROME_PATH ?? "").trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = (process.env.AUTO_IMPORT_PROFILE ?? "").trim() || defaultProfileDir();
const leagueId = (process.env.AUTO_IMPORT_LEAGUE_ID ?? process.argv[2] ?? "").trim();
if (!/^\d{1,12}$/.test(leagueId)) {
  console.error("Usage: AUTO_IMPORT_LEAGUE_ID=<yahoo league number> npm run yahoo:login   (or: npm run yahoo:login -- <number>)");
  process.exit(2);
}
fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
console.log(`Opening Chrome on ${profileDir}. Sign in to Yahoo in that window, check your league shows, then quit that Chrome (Cmd+Q).`);
const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${profileDir}`,
    "--use-mock-keychain",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    leagueUrl(leagueId),
  ],
  { stdio: "ignore" },
);
chrome.on("error", (e) => {
  console.error(`Could not start Chrome at ${chromePath}: ${e.message} (set CHROME_PATH)`);
  process.exit(1);
});
chrome.on("exit", () => console.log("Chrome closed. The auto-import will use this profile on its next run."));
