# Connecting your Yahoo Fantasy league

Fantasy Trade Desk reads your league (settings, scoring, rosters, standings,
free agents) straight from Yahoo's Fantasy Sports API. It only ever **reads** —
it can't make moves for you. Setup takes about five minutes and only has to be
done once.

## 1. Create a Yahoo developer app

1. Sign in at <https://developer.yahoo.com/apps/create/> with **the same Yahoo
   account you use for fantasy football**.
2. Fill in the form:
   | Field | Value |
   |---|---|
   | Application Name | anything, e.g. `Fantasy Trade Desk (personal)` |
   | OAuth Client Type | **Confidential Client**. (*Public Client* gives you no Client Secret, and this app needs one.) Older versions of the form call this *Application Type*; there, pick **Installed Application**, or *Web Application* if that is the only choice. |
   | Description | optional |
   | Homepage URL | optional (e.g. `https://localhost:3000`) |
   | Redirect URI(s) | `https://localhost:3000/auth/yahoo/callback` |
   | API Permissions | tick **Fantasy Sports** → **Read** |
3. Click **Create App**. Yahoo shows a **Client ID (Consumer Key)** and a
   **Client Secret (Consumer Secret)**. Keep this page open.

> **About the redirect URI.** Yahoo requires an `https://` redirect URI, but
> this app runs on plain `http://localhost`. That's fine: by default the app
> uses Yahoo's *out-of-band* ("oob") flow, where Yahoo shows you a short code
> that you paste into the app. The URI above is only a placeholder that Yahoo
> insists on — nothing is ever sent to it in the default setup.

## 2. Put the credentials in `.env`

In the project folder:

```bash
cp .env.example .env
```

Open `.env` and fill in:

```ini
YAHOO_CLIENT_ID=dj0yJmk9...your-client-id...
YAHOO_CLIENT_SECRET=0123abcd...your-client-secret...
YAHOO_REDIRECT_URI=
PORT=3000
# Optional; only needed if Yahoo shows a permissions error (see Troubleshooting)
# YAHOO_SCOPE=fspt-r
```

Leave `YAHOO_REDIRECT_URI` **blank** (see *Advanced* below for the only reason
to set it). Restart the app after editing `.env` (`Ctrl+C`, then `npm run dev`).

`.env` is git-ignored; never commit it or share the secret.

## 3. Connect (first run)

1. Open the app (<http://localhost:5173> in `npm run dev`, or
   <http://localhost:3000> with `npm start`) and go to the **Connect** tab.
2. Click **Connect Yahoo**. A Yahoo page opens asking you to allow the app to
   read your Fantasy Sports data. Make sure the account shown is your fantasy
   account, then click **Agree**.
3. Yahoo then opens a plain page that says something like *"Please enter this
   code into Fantasy Trade Desk"* with a short code underneath (about 7
   letters and numbers, e.g. `abc12de`). This is the "oob" (out-of-band) step:
   the app never receives the code on its own, so you carry it over yourself.
   Select the code and copy it.
4. Switch back to the app tab, paste the code into the **code** box on the
   Connect tab and submit it. You should see "Connected". You can then close the
   Yahoo tab.
5. Pick your league from the list (for example *league id 1405188*). The first
   import makes ~15 requests to Yahoo (settings, standings, one per team
   roster), so give it 5–10 seconds.

The code works once and expires after a few minutes — if you're slow, just
click **Connect Yahoo** again for a fresh one.

Your login is saved in `.data/yahoo-tokens.json` (only readable by your user)
and refreshed automatically, so you stay connected across restarts. **Disconnect**
on the Connect tab deletes that file.

## Refreshing data

League data (rosters, standings) and the free-agent list are cached for
**15 minutes** in `.data/yahoo-league-<key>.json` and `.data/yahoo-fa-<key>.json`
to stay well under Yahoo's rate limits. To force a fresh pull:

* use the app's refresh button, or
* call `http://localhost:3000/api/league/yahoo/<league key>?refresh=1`, or
* delete the `.data/yahoo-league-*.json` / `.data/yahoo-fa-*.json` files.

Please don't refresh in a tight loop — see *999* below.

## Troubleshooting

| Symptom | What to do |
|---|---|
| **"Yahoo is not configured"** | `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` are missing from `.env`, or you didn't restart after editing it. |
| **401 / "Click Connect Yahoo again"** / `token_expired`, `invalid_grant` | The saved login was revoked or expired (e.g. you changed your Yahoo password or removed the app). Click **Disconnect**, then **Connect Yahoo** again. |
| **Yahoo error about permissions/scope while connecting** (e.g. "invalid scope", or the consent page doesn't mention Fantasy Sports) | First check the app has **Fantasy Sports → Read** ticked at <https://developer.yahoo.com/apps/>. If it does and the error continues, add `YAHOO_SCOPE=fspt-r` to `.env`, restart and click **Connect Yahoo** again. This makes the app ask Yahoo for Fantasy Sports read access explicitly. |
| **Code rejected when pasting** | Codes are single-use and short-lived. Start again with **Connect Yahoo** and paste the new code right away. Also check `YAHOO_REDIRECT_URI` is blank (a code from the oob flow only works with `redirect_uri=oob`). |
| **999 / "rate-limiting"** (the app reports it as 429) | Yahoo temporarily blocks clients that make too many requests. Wait 5–15 minutes. The app already sends one request at a time and caches for 15 minutes; avoid repeated `?refresh=1`. |
| **No leagues listed / wrong leagues** | You connected a different Yahoo account than the one in your league. Disconnect, sign out of Yahoo in your browser (or use a private window), and connect again with the right account. Only the **current NFL season's** leagues are listed. |
| **403 or "could not find that league"** | The connected account must be a member of the league. Private leagues work fine as long as you're in them — Yahoo never exposes a private league to non-members, even read-only. You can also enter the league id (`1405188`) or a full key as shown in the league list (`<game id>.l.1405188`; the game id changes every season). |
| **Some players listed as "unmatched"** | A rostered player couldn't be matched to the free player database (very new signings, practice-squad call-ups). They're shown on the team but not valued. Usually fixes itself within a day when the data files update. |
| **"Could not parse Yahoo response for …"** | Yahoo returned something the importer didn't expect. The error message contains the endpoint and the first 500 characters of Yahoo's reply (the full reply is in the server console). Please copy it into a bug report. |

## Advanced: callback (redirect-URI) mode

If you'd rather not paste a code, you can let Yahoo redirect back to the app —
but Yahoo only redirects to **https** URLs, so you need an https tunnel or
reverse proxy (e.g. `ngrok http 3000`, Cloudflare Tunnel, or Caddy with a local
certificate) in front of the app:

1. Register the tunnel's URL in your Yahoo app, e.g.
   `https://your-name.ngrok-free.app/auth/yahoo/callback`.
2. Set the exact same value in `.env`:
   `YAHOO_REDIRECT_URI=https://your-name.ngrok-free.app/auth/yahoo/callback`
3. Restart, open the app **through the tunnel URL**, and click **Connect Yahoo**.
   After you click Agree, Yahoo sends you back to `/?connected=1`.

The two values must match character-for-character, or Yahoo rejects the login.
