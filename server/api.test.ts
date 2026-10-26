// Unit test for the per-league result cache in api.ts (re-import must bust every cache of that league).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cached, cacheKeys, importerName, invalidateLeague } from "./api.js";

test("invalidateLeague drops every cache of that league only", async () => {
  const keys = ["import:y1:ctx", "import:y1:trades:1::::2:2", "import:y1:trades2:1:balanced::::2:2", "import:y1:bench:1:balanced", "import:y1:waivers:1", "import:y1:breakouts:1:all:30:0", "import:y12:ctx", "demo:y1:ctx"];
  for (const k of keys) await cached(k, false, async () => k);
  let calls = 0;
  await cached("import:y1:ctx", false, async () => (calls++, "x"));
  assert.equal(calls, 0, "served from cache");
  invalidateLeague("import", "y1");
  assert.deepEqual(cacheKeys().filter((k) => keys.includes(k)).sort(), ["demo:y1:ctx", "import:y12:ctx"]);
  assert.equal(await cached("import:y1:ctx", false, async () => (calls++, "fresh")), "fresh");
  assert.equal(calls, 1, "recomputed after the bust");
});

test("importerName: the Discord display name, Admin in dev mode or when blank", () => {
  assert.equal(importerName({ dev: false, name: "  Rai   T " }), "Rai T");
  assert.equal(importerName({ dev: true, name: "Developer (dev mode)" }), "Admin");
  assert.equal(importerName({ dev: false, name: "   " }), "Admin");
  assert.equal(importerName({ dev: false, name: "x".repeat(80) }).length, 60);
});
