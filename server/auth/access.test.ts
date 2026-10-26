import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccessFile, parseAccess, roleOf } from "./access.js";

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
