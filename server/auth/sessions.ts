// Server-side sessions for Discord sign-in (docs/DESIGN.md "Discord sign-in, multi-tenant").
// The cookie holds only a random 32-byte id, HMAC-signed with SESSION_SECRET; the store keys rows by
// SHA-256(id), so neither the file nor a log line ever holds a usable cookie. Rows live in an in-memory
// Map (single process) loaded once at start and written through on every change (atomic writeJson).
// Signed OAuth state ({nonce, next, exp}) helpers live here too: same HMAC, different domain tag.
import crypto from "node:crypto";
import { readJson, writeJson } from "../providers/store.js";

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface SessionRow {
  uid: string;
  name: string;
  avatar: string | null;
  csrf: string;
  createdMs: number;
  expiresMs: number;
  /** Admin "view as": the Discord id of the user whose scope this session sees. */
  actAs?: string;
}
export interface Session extends SessionRow {
  /** SHA-256 of the raw id: the store key (never the cookie value). */
  key: string;
}

/** Persistence for the session map; tests inject a temp-dir or in-memory version. */
export interface SessionIO {
  read(): Promise<unknown>;
  write(rows: Record<string, SessionRow>): Promise<void>;
}
export const fileIO: SessionIO = {
  read: () => readJson<unknown>("sessions"),
  write: (rows) => writeJson("sessions", rows, { secret: true }),
};

const b64url = (b: Buffer) => b.toString("base64url");
export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest();
export const hashId = (id: string) => sha256(id).toString("hex");

/** Constant-time string equality (hashes first: timingSafeEqual throws on unequal lengths). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function mac(secret: string, domain: string, value: string): Buffer {
  return crypto.createHmac("sha256", secret).update(`${domain}\n${value}`).digest();
}

function verifyMac(secret: string, domain: string, value: string, sig: string): boolean {
  const given = Buffer.from(sig, "base64url");
  const want = mac(secret, domain, value);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/** Cookie value for a raw session id: `<id>.<hmac>`. */
export function signSessionId(id: string, secret: string): string {
  return `${id}.${b64url(mac(secret, "td-session", id))}`;
}

/** The raw session id when the cookie value is well-formed and correctly signed, else null. */
export function verifySessionCookie(value: string | undefined, secret: string): string | null {
  if (!value || value.length > 200) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) return null;
  return verifyMac(secret, "td-session", id, value.slice(dot + 1)) ? id : null;
}

export interface OAuthState {
  n: string;
  next: string;
  exp: number;
}

export function signState(next: string, secret: string, now = Date.now()): string {
  const st: OAuthState = { n: b64url(crypto.randomBytes(16)), next, exp: now + STATE_TTL_MS };
  const body = b64url(Buffer.from(JSON.stringify(st)));
  return `${body}.${b64url(mac(secret, "td-state", body))}`;
}

/** Verified state, or why it failed ("bad_signature" covers malformed tokens too). */
export function verifyState(token: string, secret: string, now = Date.now()): OAuthState | "bad_signature" | "expired" {
  if (!token || token.length > 2000) return "bad_signature";
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return "bad_signature";
  const body = token.slice(0, dot);
  if (!verifyMac(secret, "td-state", body, token.slice(dot + 1))) return "bad_signature";
  let st: Partial<OAuthState>;
  try {
    st = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OAuthState>;
  } catch {
    return "bad_signature";
  }
  if (typeof st.n !== "string" || typeof st.next !== "string" || typeof st.exp !== "number") return "bad_signature";
  if (!(st.exp > now)) return "expired";
  return { n: st.n, next: st.next, exp: st.exp };
}

function validRow(v: unknown): v is SessionRow {
  const r = v as Partial<SessionRow> | null;
  return (
    !!r &&
    typeof r.uid === "string" &&
    typeof r.name === "string" &&
    (r.avatar === null || typeof r.avatar === "string") &&
    typeof r.csrf === "string" &&
    r.csrf.length >= 20 &&
    typeof r.createdMs === "number" &&
    typeof r.expiresMs === "number" &&
    (r.actAs === undefined || typeof r.actAs === "string")
  );
}

export class SessionStore {
  private rows = new Map<string, SessionRow>();
  private writing: Promise<void> = Promise.resolve();
  /** A failed write leaves the file behind memory (e.g. a revoked session still on disk): retried until it lands. */
  private dirty = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  static RETRY_MS = 5_000;
  static MAX_RETRIES = 60;

  constructor(
    private io: SessionIO = fileIO,
    private now: () => number = Date.now,
    private ttlMs = SESSION_TTL_MS,
  ) {}

  /** Load once at start. A missing or unreadable file = no sessions (everyone signs in again). */
  async load(): Promise<void> {
    const raw = await this.io.read();
    this.rows.clear();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const t = this.now();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^[0-9a-f]{64}$/.test(k) && validRow(v) && v.expiresMs > t) this.rows.set(k, { ...v });
    }
  }

  get size(): number {
    return this.rows.size;
  }

  /** New session; returns the RAW id (for the cookie only; the store keeps its hash). */
  async create(u: { uid: string; name: string; avatar: string | null }): Promise<{ id: string; session: Session }> {
    const id = b64url(crypto.randomBytes(32));
    const t = this.now();
    const row: SessionRow = { uid: u.uid, name: u.name, avatar: u.avatar, csrf: b64url(crypto.randomBytes(24)), createdMs: t, expiresMs: t + this.ttlMs };
    const key = hashId(id);
    this.rows.set(key, row);
    await this.persist();
    return { id, session: { ...row, key } };
  }

  /** The live session for a raw id (not revoked, not expired), else null. */
  get(id: string): Session | null {
    const key = hashId(id);
    const row = this.rows.get(key);
    if (!row) return null;
    if (!(row.expiresMs > this.now())) {
      this.rows.delete(key);
      void this.persist().catch(() => undefined);
      return null;
    }
    return { ...row, key };
  }

  async setActAs(key: string, actAs: string | null): Promise<void> {
    const row = this.rows.get(key);
    if (!row) return;
    if (actAs) row.actAs = actAs;
    else delete row.actAs;
    await this.persist();
  }

  async revoke(key: string): Promise<boolean> {
    const had = this.rows.delete(key);
    if (had) await this.persist();
    return had;
  }

  /** True while memory has changes the file does not (a write failed and has not been retried successfully yet). */
  get pendingWrite(): boolean {
    return this.dirty;
  }

  /** Write memory to disk now if a previous write failed. Resolves true when the file is current. */
  async flush(): Promise<boolean> {
    if (!this.dirty) return true;
    try {
      await this.persist();
      return true;
    } catch {
      return false;
    }
  }

  /** Serialised write-through of the whole map (expired rows dropped). A failure marks the store dirty and schedules
   *  bounded retries (every RETRY_MS, at most MAX_RETRIES), so a logout that could not be saved still lands on disk. */
  private persist(): Promise<void> {
    const run = async () => {
      const t = this.now();
      const out: Record<string, SessionRow> = {};
      for (const [k, r] of this.rows) if (r.expiresMs > t) out[k] = r;
      await this.io.write(out);
    };
    const p = this.writing.then(run, run).then(
      () => {
        this.dirty = false;
        this.retries = 0;
      },
      (e: unknown) => {
        this.dirty = true;
        this.scheduleRetry();
        throw e;
      },
    );
    this.writing = p.catch(() => undefined);
    return p;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.retries >= SessionStore.MAX_RETRIES) return;
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, SessionStore.RETRY_MS);
    this.retryTimer.unref();
  }
}
