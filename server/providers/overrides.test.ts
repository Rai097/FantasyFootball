// The owner's season marks store (.data/overrides-<id>.json): set / clear under a lock, bad ids refused, corrupt file
// fails closed, deleted with the league. cwd moves to a temp dir BEFORE the module loads (DATA_DIR = cwd/.data).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-overrides-"));
process.chdir(work);
const { MAX_SEASON_MARKS, deleteOverrides, isValidPlayerId, marksOf, readOverrides, setSeasonMark } = await import("./overrides.js");
const file = (id: string) => path.join(work, ".data", `overrides-${id}.json`);

test("set, flip and clear one player's mark; no marks left removes the file", async () => {
  assert.deepEqual(marksOf(await readOverrides("yA")), undefined, "no file: no marks");
  await setSeasonMark("yA", "00-0036322", true, "Owner");
  await setSeasonMark("yA", "DEF:KC", false);
  let o = await readOverrides("yA");
  assert.deepEqual({ ...marksOf(o) }, { "00-0036322": true, "DEF:KC": false });
  assert.equal(o.players["00-0036322"].setBy, "Owner");
  assert.ok(Date.parse(o.players["00-0036322"].setAt) > 0);
  await setSeasonMark("yA", "00-0036322", false);
  assert.equal(marksOf(await readOverrides("yA"))!["00-0036322"], false, "flipped");
  await setSeasonMark("yA", "00-0036322", null);
  await setSeasonMark("yA", "nobody", null); // clearing a missing mark is a no-op
  o = await readOverrides("yA");
  assert.deepEqual({ ...marksOf(o) }, { "DEF:KC": false });
  await setSeasonMark("yA", "DEF:KC", null);
  assert.equal(fs.existsSync(file("yA")), false, "empty → file removed");
});

test("concurrent writers never lose a mark (one lock per league)", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => setSeasonMark("yB", `p${i}`, i % 2 === 0)));
  const m = marksOf(await readOverrides("yB"))!;
  assert.equal(Object.keys(m).length, 20);
  assert.equal(m.p3, false);
  assert.equal(m.p4, true);
});

test("bad ids are refused; prototype keys never become marks; the per-league cap holds", async () => {
  for (const bad of ["../x", "a/b", "__proto__", "constructor", "", "x".repeat(65)]) {
    assert.equal(isValidPlayerId(bad), false, bad);
    await assert.rejects(setSeasonMark("yC", bad, true), /Bad player id/);
  }
  await assert.rejects(setSeasonMark("../etc", "p1", true), /Bad import id/);
  await assert.rejects(readOverrides("a.b"), /Bad import id/);
  // A hand-edited file: bad entries are dropped, good ones kept.
  fs.mkdirSync(path.join(work, ".data"), { recursive: true });
  fs.writeFileSync(file("yD"), JSON.stringify({ version: 1, players: { ok: { seasonOver: true, setAt: "x" }, bad: { seasonOver: "yes" }, "../x": { seasonOver: true } } }));
  assert.deepEqual({ ...marksOf(await readOverrides("yD")) }, { ok: true });
  // Cap.
  const many = { version: 1, players: Object.fromEntries(Array.from({ length: MAX_SEASON_MARKS }, (_, i) => [`m${i}`, { seasonOver: true, setAt: "" }])) };
  fs.writeFileSync(file("yE"), JSON.stringify(many));
  await assert.rejects(setSeasonMark("yE", "one-more", true), /already has 500/);
  await setSeasonMark("yE", "m1", false); // changing an existing mark is fine
});

test("a corrupt file fails closed (the owner's marks are unknown, never silently 'automatic'); delete removes the file", async () => {
  fs.writeFileSync(file("yF"), "{not json");
  await assert.rejects(readOverrides("yF"), /unreadable/);
  await assert.rejects(setSeasonMark("yF", "p", true), /unreadable/);
  assert.equal(fs.readFileSync(file("yF"), "utf8"), "{not json", "never overwritten");
  await deleteOverrides("yF");
  assert.equal(fs.existsSync(file("yF")), false);
  await deleteOverrides("../nope"); // invalid id: nothing happens
});
