import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGroupOf, groupChecks, lineupTotal, parseLineupChange, toneIcon, verdictClass, verdictReason } from "./tradeView";

test("lineup change line becomes slot, out, in and a delta", () => {
  const r = parseLineupChange("RB1: Bijan Robinson 12.3 → Jahmyr Gibbs 14.0");
  assert.equal(r.slot, "RB1");
  assert.equal(r.out, "Bijan Robinson");
  assert.equal(r.inn, "Jahmyr Gibbs");
  assert.ok(Math.abs((r.delta ?? 0) - 1.7) < 1e-9);
});

test("an empty slot counts as 0 points; a drop line stays a note with no delta", () => {
  const e = parseLineupChange("TE: empty → Sam LaPorta 8.5");
  assert.equal(e.out, undefined);
  assert.equal(e.delta, 8.5);
  const d = parseLineupChange("Drop: Some Guy (value 3.2)");
  assert.equal(d.note, "Drop: Some Guy (value 3.2)");
  assert.equal(d.delta, undefined);
});

test("lineup total sums known deltas and is unknown (not 0) when none", () => {
  assert.equal(lineupTotal([{ slot: "x", note: "n" }]), undefined);
  const rows = ["A: p 1.0 → q 3.0", "B: r 5.0 → s 4.0"].map(parseLineupChange);
  assert.equal(lineupTotal(rows), 1);
});

test("every detail lands in exactly one group, unknown labels in Other, Verdict goes to the bar", () => {
  const items = [
    { label: "Verdict", value: "Accept" },
    { label: "Balanced bar", value: "ok" },
    { label: "Acceptance", value: "60%" },
    { label: "Market: you get", value: "10.0" },
    { label: "Brand new check", value: "x" },
    { label: "Bye cover lost", value: "y", tone: "warn" as const },
  ];
  const groups = groupChecks(items);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), items.length - 1);
  assert.equal(checkGroupOf("Brand new check"), "Other");
  assert.deepEqual(groups.map((g) => g.group), ["Your side", "Their side", "Market", "Other"]);
});

test("verdict colour and the deciding reason", () => {
  assert.equal(verdictClass("Accept"), "good");
  assert.equal(verdictClass("Accept if they will"), "warn");
  assert.equal(verdictClass("Fair, lean decline"), "warn");
  assert.equal(verdictClass("Decline"), "bad");
  assert.equal(verdictClass("They won't accept"), "bad");
  const base = { summary: "S", details: [{ label: "Balanced bar", value: "bar text" }, { label: "For them", value: "a loss" }] };
  assert.equal(verdictReason(base), "a loss");
  assert.equal(verdictReason({ summary: "S", details: [{ label: "Balanced bar", value: "bar text" }] }), "bar text");
  assert.equal(verdictReason({ summary: "S" }), "S");
});

test("tone icons", () => {
  assert.equal(toneIcon("pos").icon, "✓");
  assert.equal(toneIcon("neg").icon, "✗");
  assert.equal(toneIcon("warn").icon, "!");
});
