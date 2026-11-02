import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccessFile, mergeUserRows, parseAccess, roleOf } from "./access.js";

const ADMIN = "100000000000000001";
const USER = "200000000000000002";

test("parseAccess: valid rows kept, bad rows dropped, wrong shape = null", () => {
  const l = parseAccess({
    admins: [ADMIN, "nope"],
    users: [
      { discordId: USER, leagueId: "y1405188", teamId: "4", note: "x" },
      { discordId: "300000000000000003", leagueId: "../etc", teamId: "1" },
      { discordId: USER, leagueId: "y1", teamId: "2" },
      { discordId: ADMIN, leagueId: "y1", teamId: "2" },
    ],
  });
  assert.deepEqual(l, { admins: [ADMIN], users: [{ discordId: USER, leagueId: "y1405188", teamId: "4", note: "x" }] });
  assert.equal(parseAccess(null), null);
  assert.equal(parseAccess([]), null);
  assert.equal(parseAccess({ users: [] }), null);
});

test("roleOf: admin, user, unknown, null list", () => {
  const l = parseAccess({ admins: [ADMIN], users: [{ discordId: USER, leagueId: "y1", teamId: "4" }] });
  assert.deepEqual(roleOf(l, ADMIN), { role: "admin" });
  assert.equal(roleOf(l, USER)?.role, "user");
  assert.equal(roleOf(l, "999999"), null);
  assert.equal(roleOf(null, ADMIN), null);
});

test("AccessFile: missing / invalid = nobody (fail closed); edits are picked up on the next read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-acc-"));
  const file = path.join(dir, "access.json");
  const warnings: string[] = [];
  const a = new AccessFile(file, (m) => warnings.push(m));
  assert.equal(await a.get(), null);
  fs.writeFileSync(file, "{not json");
  assert.equal(await a.get(), null);
  fs.writeFileSync(file, JSON.stringify({ admins: [ADMIN], users: [{ discordId: USER, leagueId: "y1", teamId: "4" }] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
  assert.equal(roleOf(await a.get(), USER)?.role, "user");
  fs.writeFileSync(file, JSON.stringify({ admins: [ADMIN], users: [] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 4000));
  assert.equal(roleOf(await a.get(), USER), null, "removed user is locked out");
  assert.ok(warnings.some((w) => /result=missing/.test(w)));
  assert.ok(warnings.some((w) => /result=invalid/.test(w)));
});

test("mergeUserRows: untouched rows verbatim; a touched account → one new row; a removed account's duplicates go too", () => {
  const raw = [
    { discordId: "11111", leagueId: "yL", teamId: "1", since: "x" },
    { discordId: "22222", leagueId: "y L", teamId: "2" }, // hand typo: ignored by the parser, kept verbatim
    { discordId: "33333", leagueId: "yL", teamId: "3", note: "Old" },
    { discordId: "33333", leagueId: "yL", teamId: "9" }, // shadowed duplicate
    "junk",
  ];
  const before = [
    { discordId: "11111", leagueId: "yL", teamId: "1" },
    { discordId: "33333", leagueId: "yL", teamId: "3", note: "Old" },
  ];
  // Remove 33333: both of its rows go, so the duplicate can't grant access afterwards.
  const removed = mergeUserRows(raw, before, [before[0]]);
  assert.deepEqual(removed, [raw[0], raw[1], "junk"]);
  assert.equal(parseAccess({ admins: [], users: removed })!.users.some((u) => u.discordId === "33333"), false);
  // Move 11111 and clear 33333's note: extra keys kept, the old note dropped, the duplicate gone.
  const moved = mergeUserRows(raw, before, [{ ...before[0], teamId: "4" }, { discordId: "33333", leagueId: "yL", teamId: "3" }]);
  assert.deepEqual(moved, [{ discordId: "11111", leagueId: "yL", teamId: "4", since: "x" }, raw[1], { discordId: "33333", leagueId: "yL", teamId: "3" }, "junk"]);
  // Add a new account: appended.
  const added = mergeUserRows(raw, before, [...before, { discordId: "44444", leagueId: "yL", teamId: "5" }]);
  assert.deepEqual(added.at(-1), { discordId: "44444", leagueId: "yL", teamId: "5" });
  assert.equal(added.length, raw.length + 1);
});
