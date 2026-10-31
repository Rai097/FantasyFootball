// The one access guard for every /api route and /auth/yahoo/* (docs/DESIGN.md "Discord sign-in, multi-tenant").
// Mounted at the app root before every router. For a protected path it, in order:
//   1. resolves the session (none / bad signature / revoked / expired → 401 {code:"signin"}),
//   2. re-checks access.json (id no longer listed → 403 {code:"not_allowed"}),
//   3. on writes (anything but GET/HEAD/OPTIONS): Origin == PUBLIC_URL and X-CSRF-Token == the session's csrf,
//   4. applies the route rule (admin-only, league ownership, forced team).
// It sets `req.auth` (the effective scope) that api.ts reads for team and import decisions.
// Dev mode (non-production without Discord config): every request is a built-in admin and steps 1–3 are skipped.
import type { NextFunction, Request, Response } from "express";
import type { AccessList, AccessUser } from "./access.js";
import { roleOf } from "./access.js";
import { safeEqual, verifySessionCookie, type SessionStore } from "./sessions.js";

export const SESSION_COOKIE = "td_session";
export const STATE_COOKIE = "td_oauth_state";
export const CSRF_HEADER = "x-csrf-token";

export interface Scope {
  uid: string;
  name: string;
  avatar: string | null;
  /** The signed-in account's own role. */
  realRole: "admin" | "user";
  /** Effective role: "user" while an admin views as a user. */
  role: "admin" | "user";
  csrf: string;
  /** Effective user scope (unset for an admin not acting as anyone). */
  leagueId?: string;
  teamId?: string;
  actingAs: AccessUser | null;
  /** Store key of the session (null in dev mode). */
  sessionKey: string | null;
  dev: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Scope;
    }
  }
}

export interface GuardDeps {
  mode: "discord" | "dev";
  secret: string;
  /** Origin of PUBLIC_URL, e.g. https://ff.raibot.us ("" in dev mode). */
  publicOrigin: string;
  sessions: SessionStore;
  access: { get(): Promise<AccessList | null> };
  log: (line: string) => void;
}

export class AuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

const SIGNIN_HINT = "Sign in with Discord again.";
export const errors = {
  signin: () => new AuthError(401, "signin", "Not signed in.", SIGNIN_HINT),
  notAllowed: () => new AuthError(403, "not_allowed", "This Discord account isn't on the list.", "Ask the league owner to add you."),
  adminOnly: () => new AuthError(403, "admin_only", "Only the league owner can do this.", "Ask the league owner."),
  league: () => new AuthError(403, "league", "That league isn't yours.", "You can view your own league (and the demo)."),
  team: () => new AuthError(403, "team", "That team isn't yours.", "You can view your own team only."),
  origin: () => new AuthError(403, "bad_origin", "Request not from this site.", "Open the app from its own address and try again."),
  csrf: () => new AuthError(403, "csrf", "Missing or wrong CSRF token.", "Reload the page and try again."),
};

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Effective scope for a signed-in identity under the current access list; null = not allowed. */
export function resolveScope(
  s: { uid: string; name: string; avatar: string | null; csrf: string; actAs?: string; key: string | null; dev?: boolean },
  list: AccessList | null,
): Scope | null {
  const base = { uid: s.uid, name: s.name, avatar: s.avatar, csrf: s.csrf, sessionKey: s.key, dev: !!s.dev };
  const r = s.dev ? ({ role: "admin" } as const) : roleOf(list, s.uid);
  if (!r) return null;
  if (r.role === "user") return { ...base, realRole: "user", role: "user", leagueId: r.user.leagueId, teamId: r.user.teamId, actingAs: null };
  const target = s.actAs ? list?.users.find((u) => u.discordId === s.actAs) : undefined;
  if (target) return { ...base, realRole: "admin", role: "user", leagueId: target.leagueId, teamId: target.teamId, actingAs: target };
  return { ...base, realRole: "admin", role: "admin", actingAs: null };
}

export type Rule =
  | { kind: "open" }
  | { kind: "public" }
  | { kind: "signed" }
  | { kind: "admin" }
  | { kind: "realAdmin" }
  | { kind: "league"; provider: string; id: string }
  | { kind: "importId"; id: string };

function seg(s: string | undefined): string {
  try {
    return decodeURIComponent(s ?? "");
  } catch {
    return "\u0000invalid";
  }
}

/**
 * Route rule for a request. Express matches routes case-insensitively and ignores a trailing slash, so
 * classification does too; ids keep their case and are compared exactly (fail closed).
 */
export function classify(method: string, path: string, query: Record<string, unknown> = {}): Rule {
  const lower = path.toLowerCase();
  const isApi = /^\/api(\/|$)/.test(lower);
  const isYahooAuth = /^\/auth\/yahoo(\/|$)/.test(lower);
  if (!isApi && !isYahooAuth) return { kind: "open" };
  if (isYahooAuth) return { kind: "admin" };
  const trimmed = lower.replace(/\/+$/, "");
  if ((method === "GET" || method === "HEAD") && (trimmed === "/api/import/bookmarklet.js" || trimmed === "/api/docs/import")) return { kind: "public" };
  const segs = path.split("/").filter(Boolean);
  const l = segs.map((x) => x.toLowerCase());
  switch (l[1]) {
    case "yahoo":
      return { kind: "admin" };
    case "access":
      return { kind: "realAdmin" };
    case "auth":
      return l[2] === "act-as" ? { kind: "realAdmin" } : { kind: "signed" };
    case "league":
      return { kind: "league", provider: seg(segs[2]), id: seg(segs[3]) };
    case "players": {
      const q = (k: string, d: string) => (typeof query[k] === "string" && query[k] ? String(query[k]) : query[k] === undefined || query[k] === "" ? d : "\u0000invalid");
      return { kind: "league", provider: q("provider", "demo"), id: q("id", "42") };
    }
    case "autoimport":
      // Status: any signed-in account. "Refresh from Yahoo now" (any write): the league owner only.
      return method === "GET" || method === "HEAD" ? { kind: "signed" } : { kind: "admin" };
    case "import":
      if (segs.length <= 2) return { kind: "signed" }; // list (filtered) / POST (checked in the handler)
      if (method === "DELETE" && segs.length === 3) return { kind: "admin" };
      if (method === "PUT" && l[3] === "settings") return { kind: "admin" };
      return { kind: "importId", id: seg(segs[2]) };
    default:
      return { kind: "signed" };
  }
}

const isWrite = (m: string) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

/** Users may open the demo league and their own imported league; nothing else (Yahoo provider included). */
export function leagueAllowed(scope: Scope, provider: string, id: string): boolean {
  if (scope.role === "admin") return true;
  if (provider === "demo") return true;
  return provider === "import" && id === scope.leagueId;
}

/** The team a user is pinned to for this provider (their own imported league only), else undefined. */
export function pinnedTeam(scope: Scope, provider: string): string | undefined {
  return scope.role === "user" && provider === "import" ? scope.teamId : undefined;
}

/** The request's effective scope; a route reached without the guard fails closed. */
export function scopeOf(req: Request): Scope {
  if (!req.auth) throw errors.signin();
  return req.auth;
}

const clean = (s: string) => s.replace(/[^\w./:@-]/g, "_").slice(0, 120);

export function createGuard(d: GuardDeps) {
  let devActAs: string | undefined;

  /** Session identity from the cookie, or null. Dev mode: the built-in admin. */
  function identity(req: Request) {
    if (d.mode === "dev") return { uid: "dev", name: "Developer (dev mode)", avatar: null, csrf: "dev-mode", actAs: devActAs, key: null, dev: true };
    const id = verifySessionCookie(parseCookies(req.headers.cookie)[SESSION_COOKIE], d.secret);
    const s = id ? d.sessions.get(id) : null;
    return s ? { uid: s.uid, name: s.name, avatar: s.avatar, csrf: s.csrf, actAs: s.actAs, key: s.key } : null;
  }

  async function scopeFor(req: Request): Promise<Scope | AuthError> {
    const who = identity(req);
    if (!who) return errors.signin();
    const list = await d.access.get();
    const scope = resolveScope(who, list);
    if (!scope) return errors.notAllowed();
    return scope;
  }

  function writeCheck(req: Request, scope: Scope): AuthError | null {
    if (scope.dev) return null;
    const origin = String(req.headers.origin ?? "").replace(/\/+$/, "").toLowerCase();
    if (!origin || !safeEqual(origin, d.publicOrigin)) return errors.origin();
    const tok = req.headers[CSRF_HEADER];
    if (typeof tok !== "string" || !tok || !safeEqual(tok, scope.csrf)) return errors.csrf();
    return null;
  }

  function ruleCheck(req: Request, rule: Rule, scope: Scope): AuthError | null {
    switch (rule.kind) {
      case "admin":
        return scope.role === "admin" ? null : errors.adminOnly();
      case "realAdmin":
        return scope.realRole === "admin" ? null : errors.adminOnly();
      case "importId":
        return scope.role === "admin" || rule.id === scope.leagueId ? null : errors.league();
      case "league": {
        if (!leagueAllowed(scope, rule.provider, rule.id)) return errors.league();
        const pinned = pinnedTeam(scope, rule.provider);
        if (pinned) {
          const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
          for (const v of [req.query.team, body.team]) {
            if (v === undefined || v === "" || v === null) continue;
            if (typeof v !== "string" || v !== pinned) return errors.team();
          }
        }
        return null;
      }
      default:
        return null;
    }
  }

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const rule = classify(req.method, req.path, req.query as Record<string, unknown>);
    if (rule.kind === "open" || rule.kind === "public") return next();
    scopeFor(req)
      .then((r) => {
        let err: AuthError | null = r instanceof AuthError ? r : null;
        const scope = r instanceof AuthError ? null : r;
        if (scope && isWrite(req.method)) err = writeCheck(req, scope);
        if (scope && !err) err = ruleCheck(req, rule, scope);
        if (err) {
          if (err.status === 403) d.log(`[auth] event=refused uid=${scope?.uid ?? "-"} code=${err.code} method=${req.method} path=${clean(req.path)}`);
          return void res.status(err.status).set("Cache-Control", "no-store").json({ error: err.message, code: err.code, hint: err.hint });
        }
        req.auth = scope!;
        if (isWrite(req.method)) d.log(`[auth] event=write uid=${scope!.uid}${scope!.actingAs ? ` as=${scope!.actingAs.discordId}` : ""} method=${req.method} path=${clean(req.path)} result=allowed`);
        next();
      })
      .catch(next);
  };

  return {
    middleware,
    scopeFor,
    /** Admin "view as" (null = back to admin). Caller checked realRole and that the id is a listed user. */
    async setActAs(scope: Scope, discordId: string | null): Promise<void> {
      if (scope.dev) devActAs = discordId ?? undefined;
      else if (scope.sessionKey) await d.sessions.setActAs(scope.sessionKey, discordId);
    },
  };
}
export type Guard = ReturnType<typeof createGuard>;
