# Import your Yahoo league without the Yahoo API

Yahoo now approves Fantasy API apps one at a time, which can take one to two
weeks. Until yours is approved you can still use Trade Desk with your real
league: you copy the information from Yahoo's own web pages (where you are
already logged in) and paste it into Trade Desk.

There are two ways. **The bookmark** (recommended) grabs every team, your
league settings and the free-agent list in one click. **Paste roster text** is
a manual fallback that works on any device.

Nothing is ever changed on Yahoo. Trade Desk only reads what you paste.

---

## Option 1: the bookmark (desktop browser)

You do this once:

1. Open Trade Desk and go to the **Connect** tab.
2. Find **Import from Yahoo (browser)**. Make sure your browser's bookmarks
   bar is visible (Chrome/Edge: Ctrl+Shift+B, Mac: Cmd+Shift+B; Firefox: View
   → Toolbars → Bookmarks Toolbar; Safari: View → Show Favorites Bar).
3. Drag the blue **Trade Desk import** button onto the bookmarks bar. (Clicking it
   on the Trade Desk page does nothing; it only works on Yahoo.)

Each time you want fresh data:

1. In the same browser, open your league on
   **football.fantasysports.yahoo.com**. Any page of the league works: the
   address must contain `/f1/` followed by your league number, for example
   `https://football.fantasysports.yahoo.com/f1/1405188`.
2. Click **Trade Desk import** on your bookmarks bar.
3. Wait 10–30 seconds. A dark box appears in the top-right corner listing
   the teams it found and how many players each has.
4. Click **Copy to clipboard** (or **Download JSON** and open the file in a
   text editor and copy everything).
5. Back in Trade Desk → Connect → **Paste import JSON or roster text**, paste
   and click **Import**. You land on **My Team**.
6. Go back to the Connect tab and check **League settings** under the import
   box: scoring, roster slots, your waiver priority and which team is yours.
   Click **Save settings** after any change.

### Updating rosters (re-import)

After trades, adds and drops on Yahoo, run the bookmark again and paste the
result the same way. **You do not need to delete the league first.** Trade
Desk recognises the same Yahoo league (by its league number) and updates it
in place:

* Teams, rosters and the free-agent list are replaced with the fresh copy.
* Your settings are kept: scoring, roster slots, playoff weeks, trade
  deadline, waiver priority and which team is yours (found again by team name
  if Yahoo renumbered the teams). If you never edited the settings and the
  bookmark read them from Yahoo's settings page this time, the fresh values
  are used instead.
* All cached numbers for the league (analysis, trades, waivers, breakouts)
  are recalculated, and you land on **My Team** with a message such as
  "League updated: 2 roster changes" (or "no roster changes detected").
* This browser's backup copy is replaced by the updated league.

A roster change counts one move per team: a swap (one player in, one out)
is 1 change, and so is a pure add or a pure drop. Under **Imported leagues**
each league shows "Last import: … · N roster changes since previous"; click
**show** for the players added and dropped per team.

Trade Desk keeps the last 8 imports of each league (only the player lists,
in `.data/import-<id>-history.json`) for this comparison.

### What the bookmark reads

* Team pages `/f1/<league>/1`, `/2`, … up to 20, stopping at the first page
  that has no players. It reads each team's name and each player's name,
  position, NFL team, injury tag and lineup slot.
* The league **Settings** page: number of teams, roster positions, scoring
  (receptions, passing TDs, yards, …) and playoff weeks. If it cannot read
  them it uses Yahoo's defaults (half-PPR; QB, 2 WR, 2 RB, TE, W/R/T, K, DEF,
  6 bench, IR) and Trade Desk shows a yellow warning until you check them.
* The top ~150 available players (free agents and players on waivers).

It only makes requests to Yahoo pages of *your* league, in *your* browser,
and never sends the data anywhere. You carry it over by copy and paste.

### If the counts look wrong

Yahoo's page layout was not visible when this tool was written, so the first
run may miss things. If the box shows 0 teams, too few players, or players
without positions:

1. Click **Copy diagnostics** in the box.
2. Send what you copied to whoever maintains your Trade Desk. It contains page
   addresses, counts and a few short text samples of the rows. It holds no passwords
   or cookies.

Meanwhile use Option 2.

---

## Option 2: paste roster text (any device)

1. On Yahoo, open a team's roster page.
2. Select the roster table with the mouse (or long-press → Select all on a
   phone) and copy it.
3. In Trade Desk → Connect → **Paste import JSON or roster text**, paste it.
4. Type the **Team name** and pick **Add to**:
   * **New league** for the first team, then
   * your imported league for each further team (a team with the same name
     is replaced, so you can refresh one roster at a time).
5. Click **Import**.

To paste several teams at once, put a line like `=== Team Name ===` before
each team's text. They are imported as one new league.

Trade Desk recognises player lines like:

```
Patrick Mahomes KC - QB
Ja'Marr Chase Cin - WR
Josh Allen (QB - BUF)
```

It also handles the name and the `Team - Pos` part on separate lines. Other
lines (headers, projections, "Player Note") are ignored, and Trade Desk tells you how
many it skipped.

**Limits of paste mode:** no league settings (Yahoo defaults are used, so
edit them), no free-agent list (every ranked player not on a pasted roster
counts as available, so paste *all* teams for accurate waivers), and injury
tags only when they appear as a separate word (Q, D, O, IR) before the team.
With only your own team pasted, trade suggestions are empty because there is
no other team to trade with.

---

## Good to know

* **Waiver priority** is not on the pages the bookmark reads. Enter yours in
  League settings so waiver advice accounts for it.
* **Players that could not be matched** to Trade Desk's player database
  (rare: brand-new signings, unusual name spellings) are listed at the top of
  My Team and left out of the numbers.
* Your browser keeps a backup copy of each import. The hosted Trade Desk
  forgets imports when it restarts (free hosting sleeps after ~15 idle
  minutes). When that happens this browser uploads the backup again
  automatically. On a different browser or device, import again.
* Data is a snapshot. Re-import after trades, waivers, or when injuries change
  (see "Updating rosters" above: your settings are kept).
* For developers: `POST /api/import` with a league already imported answers
  `{ id, updated: true, changes: { teams, playersChanged } }`;
  `GET /api/import/<id>/history` lists the stored snapshots
  (`[{ importedAt, teams: [{ id, name, count }] }]`) and
  `GET /api/import/<id>/changes` gives the added / dropped players per team
  between the two most recent imports.
* Limits per import: 1 MB, 20 teams, 40 players per team.

## Yahoo's terms

This reads your own league's pages, in your browser, while you are logged in,
for personal use, the same as looking at them yourself. It does not use
Yahoo's API or share your login, and it makes about 25 page requests per
run. Automated access to Yahoo is governed by Yahoo's Terms of Service. Keep
it to your own leagues and occasional manual runs, and do not use it to
collect data at scale or to republish Yahoo content. Once your Yahoo API app
is approved, prefer the official connection (see
[YAHOO_SETUP.md](YAHOO_SETUP.md)).
