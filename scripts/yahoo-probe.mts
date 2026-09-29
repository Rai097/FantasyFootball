/**
 * Yahoo Fantasy API probe.
 *
 * Runs the same OAuth "oob" login the app uses, then calls a handful of
 * Fantasy Sports endpoints and reports what Yahoo says, so the same Yahoo app
 * can be tested from a different network than the deployed server.
 *
 *   npm run yahoo:probe
 *   npx tsx scripts/yahoo-probe.mts --id <client id> --secret <client secret> [--code <code>] [--no-scope]
 *
 * Credentials come from --id/--secret, then YAHOO_CLIENT_ID/YAHOO_CLIENT_SECRET
 * in the environment or .env. The secret and the tokens are never printed.
 *
 * YAHOO_PROBE_LOGIN_BASE / YAHOO_PROBE_API_BASE override the Yahoo hosts
 * (only useful for testing this script against a local mock server).
 */
import "dotenv/config";
import { createInterface } from "node:readline";

const LOGIN_BASE = (process.env.YAHOO_PROBE_LOGIN_BASE ?? "https://api.login.yahoo.com").replace(/\/$/, "");
const API_BASE = (process.env.YAHOO_PROBE_API_BASE ?? "https://fantasysports.yahooapis.com/fantasy/v2").replace(/\/$/, "");
const NOT_AUTHORIZED = "not authorized to perform this action";

// ---------- args ----------
function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log("Usage: npx tsx scripts/yahoo-probe.mts [--id ID] [--secret SECRET] [--code CODE] [--no-scope]");
  process.exit(0);
}
const str = (v: string | true | undefined) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const clientId = str(args.id) ?? process.env.YAHOO_CLIENT_ID?.trim();
const clientSecret = str(args.secret) ?? process.env.YAHOO_CLIENT_SECRET?.trim();
const useScope = !args["no-scope"];
if (!clientId || !clientSecret) {
  console.error("Missing credentials: pass --id and --secret, or set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET (env or .env).");
  process.exit(2);
}

// ---------- helpers ----------
type Result = { label: string; status: number | string; snippet: string; kind: "fantasy" | "other" };
const results: Result[] = [];
const notes: string[] = [];

function errText(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${err.message ?? "error"} (${cause})` : String(err?.message ?? e);
}

const oneLine = (s: string, n = 300) => s.replace(/\s+/g, " ").trim().slice(0, n);

function isSandboxBlock(body: string): boolean {
  return /host not in allowlist|egress settings/i.test(body);
}

function maskId(id: string): string {
  return id.length <= 12 ? id.slice(0, 4) + "…" : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (a) => { answered = true; rl.close(); resolve(a.trim()); });
    rl.on("close", () => { if (!answered) resolve(""); });
  });
}

function printSummary(verdict: string, ipLine: string): void {
  const lines = [
    "===== YAHOO PROBE SUMMARY (safe to paste; contains no secrets or tokens) =====",
    `date: ${new Date().toISOString()}`,
    `client_id: ${maskId(clientId!)}`,
    `scope: ${useScope ? "fspt-r" : "(none)"}`,
    `network: ${ipLine}`,
    ...notes.map((n) => `note: ${n}`),
    ...results.map((r) => `${r.label} -> ${r.status} | ${oneLine(r.snippet, 160)}`),
    `verdict: ${verdict}`,
    "==============================================================================",
  ];
  console.log("\n" + lines.join("\n"));
}

async function publicIp(): Promise<string> {
  try {
    const r = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    if (!r.ok) return `unavailable (ipinfo ${r.status}: ${oneLine(text, 80)})`;
    const j = JSON.parse(text) as Record<string, string>;
    return [j.ip, [j.city, j.region, j.country].filter(Boolean).join(", "), j.org].filter(Boolean).join(" | ");
  } catch (e) {
    return `unavailable (${errText(e)})`;
  }
}

async function finish(verdict: string, exitCode: number): Promise<never> {
  console.log("\n## Step 4: network + verdict");
  const ip = await publicIp();
  console.log(`Public IP/location: ${ip}`);
  console.log(`Verdict: ${verdict}`);
  printSummary(verdict, ip);
  process.exit(exitCode);
}

// ---------- step 1: consent URL ----------
const authParams = new URLSearchParams({
  client_id: clientId,
  redirect_uri: "oob",
  response_type: "code",
  language: "en-us",
});
if (useScope) authParams.set("scope", "fspt-r");
const authUrl = `${LOGIN_BASE}/oauth2/request_auth?${authParams}`;

console.log("## Step 1: authorize");
console.log(`Client id: ${maskId(clientId)}   scope: ${useScope ? "fspt-r" : "(none, --no-scope)"}`);
console.log("Open this URL in a browser, sign in with the Yahoo account that is in your league, click Agree,");
console.log("then copy the code Yahoo shows you and paste it below:\n");
console.log(authUrl + "\n");

// ---------- step 2: token exchange ----------
let code = str(args.code);
if (!code) code = await ask("Paste the code here and press Enter: ");
if (!code) {
  console.error("No code received on stdin (use --code XXXX for non-interactive runs).");
  process.exit(2);
}

console.log("\n## Step 2: exchange code for token");
let accessToken: string | undefined;
try {
  const r = await fetch(`${LOGIN_BASE}/oauth2/get_token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "oob" }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json: Record<string, unknown> | undefined;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  if (!r.ok || !json || typeof json.access_token !== "string") {
    const detail = isSandboxBlock(text)
      ? `blocked by this machine's network egress policy, not by Yahoo: ${oneLine(text, 200)}`
      : json ? `fields: ${Object.keys(json).join(", ")}; error: ${oneLine(String(json.error ?? ""), 80)} ${oneLine(String(json.error_description ?? ""), 200)}`
      : oneLine(text, 300);
    console.error(`Token exchange failed: HTTP ${r.status} — ${detail}`);
    results.push({ label: "POST get_token", status: r.status, snippet: detail, kind: "other" });
    await finish("inconclusive: token exchange failed (see above); nothing about Fantasy access was tested", 1);
  }
  accessToken = json!.access_token as string;
  console.log(`HTTP ${r.status}. Response fields: ${Object.keys(json!).join(", ")}`);
  console.log(`token_type: ${String(json!.token_type)}   expires_in: ${String(json!.expires_in)}`);
  notes.push(`token ok: fields=${Object.keys(json!).join(",")} token_type=${String(json!.token_type)} expires_in=${String(json!.expires_in)}`);
} catch (e) {
  const msg = `network error: ${errText(e)}`;
  console.error(`Token exchange failed: ${msg}`);
  results.push({ label: "POST get_token", status: "ERR", snippet: msg, kind: "other" });
  await finish(`inconclusive: could not reach ${LOGIN_BASE} (${errText(e)})`, 1);
}
const token = accessToken!;

// ---------- step 3: Fantasy API calls ----------
console.log("\n## Step 3: Fantasy Sports API calls");

async function call(label: string, url: string, headers: Record<string, string>): Promise<void> {
  const shown = url.replace(/access_token=[^&]+/, "access_token=<redacted>");
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    const snippet = isSandboxBlock(text) ? `[egress blocked, not Yahoo] ${text}` : text;
    results.push({ label, status: r.status, snippet, kind: "fantasy" });
    console.log(`\n${label}\n  GET ${shown}\n  -> ${r.status}  ${oneLine(snippet)}`);
  } catch (e) {
    results.push({ label, status: "ERR", snippet: errText(e), kind: "fantasy" });
    console.log(`\n${label}\n  GET ${shown}\n  -> ERROR  ${errText(e)}`);
  }
}

const bearer = { Authorization: `Bearer ${token}` };
for (const path of [
  "/game/nfl",
  "/games;game_codes=nfl",
  "/users;use_login=1/games",
  "/users;use_login=1/games;game_keys=nfl/leagues",
]) {
  await call(path, `${API_BASE}${path}?format=json`, bearer);
}
await call("/game/nfl (python-requests UA)", `${API_BASE}/game/nfl?format=json`, {
  ...bearer,
  "User-Agent": "python-requests/2.32.3",
  Accept: "*/*",
});
await call("/game/nfl (token in query)", `${API_BASE}/game/nfl?format=json&access_token=${encodeURIComponent(token)}`, {});
await call("/game/nfl (XML)", `${API_BASE}/game/nfl`, bearer);

// ---------- step 4: verdict ----------
const fantasy = results.filter((r) => r.kind === "fantasy");
const ok = fantasy.filter((r) => r.status === 200);
const blocked = fantasy.filter((r) => isSandboxBlock(r.snippet));
const notAuth = fantasy.filter((r) => r.status === 403 && r.snippet.toLowerCase().includes(NOT_AUTHORIZED));

let verdict: string;
if (ok.length > 0) {
  verdict = `WORKS from this network → Render's address is the problem (${ok.length}/${fantasy.length} calls returned 200: ${ok.map((r) => r.label).join("; ")})`;
} else if (notAuth.length === fantasy.length) {
  verdict = "FAILS the same way → the Yahoo app itself is not authorized (every call: 403 \"This application is not authorized to perform this action\")";
} else if (blocked.length > 0) {
  verdict = `inconclusive: ${blocked.length} call(s) were blocked by this machine's network egress policy before reaching Yahoo (allow fantasysports.yahooapis.com)`;
} else {
  const counts = new Map<string, number>();
  for (const r of fantasy) counts.set(String(r.status), (counts.get(String(r.status)) ?? 0) + 1);
  verdict = `inconclusive: statuses ${[...counts].map(([s, n]) => `${s}×${n}`).join(", ")}; see details above`;
}
await finish(verdict, ok.length > 0 ? 0 : 1);
