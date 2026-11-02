import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessOverview } from "../api";
import { accessView, cleanDiscordId, personLabel } from "./accessView";

const o: AccessOverview = {
  leagues: [{ id: "yL", name: "League", teams: [{ id: "1", name: "One" }, { id: "2", name: "Two" }, { id: "3", name: "Three" }] }],
  users: [
    { discordId: "1111111111", leagueId: "yL", teamId: "2", note: "Sam" },
    { discordId: "2222222222", leagueId: "yL", teamId: "2" },
    { discordId: "3333333333", leagueId: "yL", teamId: "9" },
  ],
  requests: [],
};

test("one row per team in league order; co-managers share a row; summary counts teams, not people", () => {
  const v = accessView(o)!;
  assert.deepEqual(v.rows.map((r) => [r.teamId, r.people.length]), [["1", 0], ["2", 2], ["3", 0]]);
  assert.equal(v.summary, "1 of 3 teams can sign in");
});

test("an account whose team is gone is listed as stale, never dropped silently", () => {
  assert.deepEqual(accessView(o)!.stale.map((u) => u.discordId), ["3333333333"]);
});

test("no imported league: nothing to assign", () => {
  assert.equal(accessView({ ...o, leagues: [] }), null);
});

test("labels and ID cleanup", () => {
  assert.equal(personLabel(o.users[0]), "Sam");
  assert.equal(personLabel(o.users[1]), "ID …2222");
  assert.equal(cleanDiscordId(" 1234 5678 9012 "), "123456789012");
  assert.equal(cleanDiscordId("@sam"), null);
  assert.equal(cleanDiscordId("12"), null);
});
