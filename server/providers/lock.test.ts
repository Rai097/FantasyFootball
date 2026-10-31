import assert from "node:assert/strict";
import { test } from "node:test";
import { lockedKeys, withLock } from "./lock.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("same key: calls run one at a time in call order", async () => {
  const order: string[] = [];
  let inside = 0;
  let maxInside = 0;
  const job = (n: string, ms: number) => async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    order.push(`start ${n}`);
    await tick(ms);
    order.push(`end ${n}`);
    inside--;
    return n;
  };
  const r = await Promise.all([withLock("k", job("a", 20)), withLock("k", job("b", 1)), withLock("k", job("c", 5))]);
  assert.deepEqual(r, ["a", "b", "c"]);
  assert.equal(maxInside, 1);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.deepEqual(lockedKeys(), []);
});

test("a failed call rejects its own caller and never blocks the next one", async () => {
  const a = withLock("f", async () => {
    throw new Error("boom");
  });
  const b = withLock("f", async () => "ok");
  await assert.rejects(a, /boom/);
  assert.equal(await b, "ok");
});

test("different keys run in parallel", async () => {
  let inside = 0;
  let maxInside = 0;
  const job = async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await tick(10);
    inside--;
  };
  await Promise.all([withLock("x", job), withLock("y", job)]);
  assert.equal(maxInside, 2);
});
