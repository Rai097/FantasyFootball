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

test("accounts not on a row (team gone, or another imported league) are listed, never dropped silently", () => {
  assert.deepEqual(accessView(o)!.others.map((x) => [x.user.discordId, x.label, x.gone]), [["3333333333", "Team 9 (gone)", true]]);
  const two: AccessOverview = { ...o, leagues: [...o.leagues, { id: "yM", name: "Other", teams: [{ id: "1", name: "M1" }] }], users: [...o.users, { discordId: "4444444444", leagueId: "yM", teamId: "1" }] };
  const v = accessView(two, "yL")!;
  assert.deepEqual(v.others.map((x) => [x.user.discordId, x.label, x.gone]), [["3333333333", "Team 9 (gone)", true], ["4444444444", "Other · M1", false]]);
  assert.equal(accessView(two, "yM")!.leagueName, "Other");
  assert.equal(accessView(two, "nope")!.leagueId, "yL", "an unknown league (e.g. the demo) falls back to the first import");
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
