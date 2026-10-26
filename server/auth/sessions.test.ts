import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashId, SessionStore, signSessionId, signState, STATE_TTL_MS, verifySessionCookie, verifyState, type SessionIO, type SessionRow } from "./sessions.js";

const SECRET = "s".repeat(40);

function tempIO(): SessionIO & { file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-sess-"));
  const file = path.join(dir, "sessions.json");
  return {
    file,
    read: async () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null),
    write: async (rows: Record<string, SessionRow>) => fs.writeFileSync(file, JSON.stringify(rows)),
  };
}

test("session cookie: signed id verifies; tampered / wrong secret / junk do not", () => {
  const id = "A".repeat(43);
  const c = signSessionId(id, SECRET);
  assert.equal(verifySessionCookie(c, SECRET), id);
  assert.equal(verifySessionCookie(c, "t".repeat(40)), null);
  assert.equal(verifySessionCookie(`B${c.slice(1)}`, SECRET), null);
  assert.equal(verifySessionCookie(`${c}x`, SECRET), null);
  assert.equal(verifySessionCookie("nodot", SECRET), null);
  assert.equal(verifySessionCookie(undefined, SECRET), null);
  assert.equal(verifySessionCookie(`${id}.`, SECRET), null);
});

test("OAuth state: round trip, bad signature, expiry", () => {
  const t0 = 1_000_000;
  const st = signState("/x?y=1", SECRET, t0);
  const ok = verifyState(st, SECRET, t0 + 1000);
  assert.ok(typeof ok === "object" && ok.next === "/x?y=1");
  assert.equal(verifyState(st, "t".repeat(40), t0), "bad_signature");
  assert.equal(verifyState(st.replace(/^./, (c) => (c === "e" ? "f" : "e")), SECRET, t0), "bad_signature");
  assert.equal(verifyState("garbage", SECRET, t0), "bad_signature");
  assert.equal(verifyState(st, SECRET, t0 + STATE_TTL_MS + 1), "expired");
});

test("store: create / get / revoke; the file holds hashes, never the raw id", async () => {
  const io = tempIO();
  const s = new SessionStore(io);
  await s.load();
  const { id, session } = await s.create({ uid: "123456", name: "A", avatar: null });
  assert.equal(session.key, hashId(id));
  assert.equal(s.get(id)?.uid, "123456");
  const file = fs.readFileSync(io.file, "utf8");
  assert.ok(!file.includes(id), "raw id must not be stored");
  assert.ok(file.includes(hashId(id)));
  assert.equal(await s.revoke(session.key), true);
  assert.equal(s.get(id), null);
  assert.ok(!fs.readFileSync(io.file, "utf8").includes(hashId(id)), "revocation written through");
});

test("store: sessions persist across a restart (reload from file); expired rows are dropped", async () => {
  const io = tempIO();
  let now = 10_000;
  const a = new SessionStore(io, () => now, 60_000);
  await a.load();
  const { id, session } = await a.create({ uid: "123456", name: "A", avatar: "ab".repeat(16) });
  await a.setActAs(session.key, "999999");
  const { id: old } = await a.create({ uid: "777777", name: "B", avatar: null });
  const b = new SessionStore(io, () => now, 60_000);
  await b.load();
  assert.equal(b.get(id)?.uid, "123456");
  assert.equal(b.get(id)?.actAs, "999999");
  assert.equal(b.get(id)?.csrf, a.get(id)?.csrf);
  now += 61_000;
  const c = new SessionStore(io, () => now, 60_000);
  await c.load();
  assert.equal(c.get(id), null);
  assert.equal(c.get(old), null);
});

test("store: a corrupt or wrong-shaped file loads as no sessions", async () => {
  const s = new SessionStore({ read: async () => ({ notahash: { uid: 1 } }), write: async () => undefined });
  await s.load();
  assert.equal(s.size, 0);
  const t = new SessionStore({ read: async () => [1, 2], write: async () => undefined });
  await t.load();
  assert.equal(t.size, 0);
});
