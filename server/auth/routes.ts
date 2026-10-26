// Discord sign-in routes + the auth API (docs/DESIGN.md "Discord sign-in, multi-tenant").
//   GET  /auth/login?next=/path   → 302 Discord authorize (signed state in the URL AND an httpOnly Lax cookie)
//   GET  /auth/callback           → state checks, code exchange, allowlist → session cookie, 302 next
//   POST /auth/logout             → revoke server-side, clear cookie
//   GET  /api/auth/me             → { id, name, avatarUrl, role, csrf, scope, actingAs, dev? }
//   POST /api/auth/act-as         → admin "view as" { discordId | null }
//   GET  /api/access              → admin: users + imported leagues/teams for the picker
// `createAuth` wires sessions + access list + guard + these routes; index.ts mounts guard first, then the router.
import express, { type NextFunction, type Request, type Response } from "express";
import { listImports, readImport } from "../providers/import.js";
import { AccessFile, type AccessList, roleOf } from "./access.js";
import { authorizeUrl, avatarUrl, discordClient, type DiscordClient } from "./discord.js";
import { createGuard, parseCookies, scopeOf, SESSION_COOKIE, STATE_COOKIE, AuthError, errors, type Scope } from "./guard.js";
import { safeEqual, SESSION_TTL_MS, SessionStore, signSessionId, signState, STATE_TTL_MS, verifySessionCookie, verifyState } from "./sessions.js";

export interface AuthOptions {
  mode: "discord" | "dev";
  clientId?: string;
  clientSecret?: string;
  sessionSecret?: string;
  /** e.g. https://ff.raibot.us (redirect URI = PUBLIC_URL + /auth/callback, never from request headers). */
  publicUrl?: string;
  discord?: DiscordClient;
  sessions?: SessionStore;
  access?: { get(): Promise<AccessList | null> };
  log?: (line: string) => void;
  now?: () => number;
}

/** A same-site path or "/": no absolute URLs, `//host`, backslashes or control characters (no open redirect). */
export function safeNext(p: unknown): string {
  if (typeof p !== "string" || !p || p.length > 512) return "/";
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\") || /[\x00-\x1f\x7f]/.test(p)) return "/";
  try {
    const u = new URL(p, "http://x.invalid");
    if (u.host !== "x.invalid") return "/";
  } catch {
    return "/";
  }
  return p;
}

// ---------------------------------------------------------------- sign-in rate limit
const PER_CLIENT_PER_MIN = 30;
const GLOBAL_PER_MIN = 300;
const MAX_CLIENTS = 5000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** CF-Connecting-IP only when the TCP peer is loopback (cloudflared on this machine), else the peer itself. */
export function clientKey(req: Request): string {
  const peer = req.socket.remoteAddress ?? "";
  if (LOOPBACK.has(peer)) {
    const cf = String(req.headers["cf-connecting-ip"] ?? "").trim().slice(0, 64);
    if (cf) return `cf:${cf}`;
  }
  return `peer:${peer}`;
}

export function signInLimiter(now: () => number = Date.now) {
  let windowStart = 0;
  let global = 0;
  const perClient = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      global = 0;
      perClient.clear();
    }
    if (!perClient.has(key) && perClient.size >= MAX_CLIENTS) perClient.clear();
    const n = (perClient.get(key) ?? 0) + 1;
    perClient.set(key, n);
    global++;
    return n <= PER_CLIENT_PER_MIN && global <= GLOBAL_PER_MIN;
  };
}

// ---------------------------------------------------------------- factory
export function createAuth(o: AuthOptions) {
  const log = o.log ?? ((l: string) => console.log(l));
  const now = o.now ?? Date.now;
  const dev = o.mode === "dev";
  const publicUrl = (o.publicUrl ?? "").replace(/\/+$/, "");
  const publicOrigin = publicUrl ? new URL(publicUrl).origin.toLowerCase() : "";
  const redirectUri = `${publicUrl}/auth/callback`;
  const secure = publicUrl.startsWith("https://");
  const secret = o.sessionSecret ?? "";
  if (!dev && (!o.clientId || !o.clientSecret || secret.length < 32 || !publicUrl)) throw new Error("Discord auth needs client id, client secret, a ≥32-char session secret and PUBLIC_URL");
  const discord = o.discord ?? discordClient(o.clientId ?? "", o.clientSecret ?? "");
  const sessions = o.sessions ?? new SessionStore(undefined, now);
  const access = o.access ?? new AccessFile();
  const guard = createGuard({ mode: o.mode, secret, publicOrigin, sessions, access, log });
  const allow = signInLimiter(now);

  const cookieOpts = (maxAgeMs: number, sameSite: "strict" | "lax") => ({ httpOnly: true, secure, sameSite, path: "/", maxAge: maxAgeMs });
  const clearCookie = (res: Response, name: string) => res.clearCookie(name, { httpOnly: true, secure, path: "/" });
  const fail = (res: Response, status: number, text: string, event: string) => {
    log(`[auth] event=login result=${event}`);
    clearCookie(res, STATE_COOKIE);
    res.status(status).type("text/plain").set("Cache-Control", "no-store").send(text);
  };

  const router = express.Router();

  router.get("/auth/login", (req, res) => {
    if (!allow(clientKey(req))) return void res.status(429).type("text/plain").send("Too many sign-in attempts right now. Please try again in a minute.");
    if (dev) return void res.redirect(302, "/");
    const state = signState(safeNext(req.query.next), secret, now());
    res.cookie(STATE_COOKIE, state, cookieOpts(STATE_TTL_MS, "lax"));
    res.set("Cache-Control", "no-store").redirect(302, authorizeUrl(o.clientId!, redirectUri, state));
  });

  router.get("/auth/callback", (req, res, next) => {
    (async () => {
      if (!allow(clientKey(req))) return void res.status(429).type("text/plain").send("Too many sign-in attempts right now. Please try again in a minute.");
      if (dev) return void res.redirect(302, "/");
      if (req.query.error) return fail(res, 400, "Discord sign-in was cancelled.", "cancelled");
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "";
      if (!code || !state || !cookieState || !safeEqual(state, cookieState)) return fail(res, 400, "Sign-in state mismatch. Please try again.", "state_mismatch");
      const st = verifyState(state, secret, now());
      if (st === "expired") return fail(res, 400, "Sign-in link expired. Please try again.", "state_expired");
      if (st === "bad_signature") return fail(res, 400, "Sign-in state invalid. Please try again.", "state_invalid");
      let user: Awaited<ReturnType<DiscordClient["me"]>> = null;
      try {
        const token = await discord.exchange(code, redirectUri);
        user = token ? await discord.me(token) : null;
      } catch (e) {
        log(`[auth] event=discord_call result=error error=${(e as Error)?.name ?? "Error"}`);
        user = null;
      }
      if (!user) return fail(res, 502, "Discord sign-in failed. Please try again.", "discord_failed");
      const role = roleOf(await access.get(), user.id);
      if (!role) {
        log(`[auth] event=login uid=${user.id} result=refused reason=not_allowed`);
        clearCookie(res, STATE_COOKIE);
        clearCookie(res, SESSION_COOKIE);
        return void res.redirect(302, "/?error=not_allowed");
      }
      const name = String(user.global_name || user.username || user.id).slice(0, 64);
      const { id } = await sessions.create({ uid: user.id, name, avatar: user.avatar ?? null });
      log(`[auth] event=login uid=${user.id} role=${role.role} result=ok`);
      clearCookie(res, STATE_COOKIE);
      res.cookie(SESSION_COOKIE, signSessionId(id, secret), cookieOpts(SESSION_TTL_MS, "strict"));
      res.set("Cache-Control", "no-store").redirect(302, safeNext(st.next));
    })().catch(next);
  });

  router.post("/auth/logout", (req, res, next) => {
    (async () => {
      if (!dev) {
        const origin = String(req.headers.origin ?? "").replace(/\/+$/, "").toLowerCase();
        if (!origin || !safeEqual(origin, publicOrigin)) {
          const e = errors.origin();
          return void res.status(e.status).json({ error: e.message, code: e.code, hint: e.hint });
        }
        const r = await guard.scopeFor(req);
        // Revoked in memory at once; if the file write fails the cookie is still cleared and the store keeps
        // retrying the write, so a restart cannot revive the session once storage works again.
        let saved = true;
        try {
          if (!(r instanceof AuthError) && r.sessionKey) {
            await sessions.revoke(r.sessionKey);
            log(`[auth] event=logout uid=${r.uid} result=ok`);
          } else {
            // Not allowlisted any more, or no session: still revoke whatever the cookie names.
            const parsed = parseCookies(req.headers.cookie)[SESSION_COOKIE];
            const id = verifySessionCookie(parsed, secret);
            const s = id ? sessions.get(id) : null;
            if (s) await sessions.revoke(s.key);
          }
        } catch {
          saved = false;
          log(`[auth] event=logout result=error reason=session_store_write_failed`);
        }
        if (!saved) {
          clearCookie(res, SESSION_COOKIE);
          return void res
            .status(503)
            .set("Cache-Control", "no-store")
            .json({ error: "Signed out on this device, but the server could not save it yet; it will keep retrying.", code: "store" });
        }
      }
      clearCookie(res, SESSION_COOKIE);
      res.set("Cache-Control", "no-store").json({ ok: true });
    })().catch(next);
  });

  const me = (s: Scope) => ({
    id: s.uid,
    name: s.name,
    avatarUrl: avatarUrl(s.uid, s.avatar),
    role: s.realRole,
    csrf: s.csrf,
    scope: s.role === "user" ? { leagueId: s.leagueId!, teamId: s.teamId! } : null,
    actingAs: s.actingAs ? { discordId: s.actingAs.discordId, note: s.actingAs.note ?? null, leagueId: s.actingAs.leagueId, teamId: s.actingAs.teamId } : null,
    ...(s.dev ? { dev: true } : {}),
  });

  // Everything below is under /api: the guard has already run and set req.auth (scopeOf fails closed).
  router.get("/api/auth/me", (req, res) => {
    res.set("Cache-Control", "no-store").json(me(scopeOf(req)));
  });

  router.post("/api/auth/act-as", (req, res, next) => {
    (async () => {
      const s = scopeOf(req);
      if (s.realRole !== "admin") throw errors.adminOnly();
      const raw = (req.body as { discordId?: unknown } | undefined)?.discordId;
      if (raw !== null && typeof raw !== "string") return void res.status(400).json({ error: "Send { discordId: string | null }.", code: "bad_request" });
      const list = await access.get();
      if (typeof raw === "string" && !list?.users.some((u) => u.discordId === raw)) return void res.status(400).json({ error: "That Discord id is not a listed user.", code: "unknown_user" });
      await guard.setActAs(s, raw);
      log(`[auth] event=act_as uid=${s.uid} target=${raw ?? "admin"} result=ok`);
      const after = await guard.scopeFor(req);
      if (after instanceof AuthError) throw after;
      res.set("Cache-Control", "no-store").json(me(after));
    })().catch(next);
  });

  router.get("/api/access", (req, res, next) => {
    (async () => {
      const s = scopeOf(req);
      if (s.realRole !== "admin") throw errors.adminOnly();
      const list = await access.get();
      const leagues: { id: string; name: string; teams: { id: string; name: string }[] }[] = [];
      for (const x of await listImports()) {
        const imp = await readImport(x.id);
        if (imp) leagues.push({ id: imp.id, name: imp.name, teams: imp.teams.map((t) => ({ id: t.id, name: t.name })) });
      }
      res.set("Cache-Control", "no-store").json({ users: list?.users ?? [], leagues });
    })().catch(next);
  });

  // AuthError → {error, code, hint} (never the Yahoo-flavoured hints of the API error handler).
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof AuthError) return void res.status(err.status).json({ error: err.message, code: err.code, hint: err.hint });
    next(err);
  });

  return { router, guard: guard.middleware, guardApi: guard, sessions, access, mode: o.mode };
}
export type Auth = ReturnType<typeof createAuth>;
