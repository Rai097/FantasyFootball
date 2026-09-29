# Hosting Trade Desk without a terminal (Render, free tier)

Use this if you can't run the app on your own computer. Everything below is
done in a web browser. Total time: about 15 minutes. The app will live at an
address like `https://fantasy-trade-desk.onrender.com`.

## 1. Deploy on Render

1. Go to <https://render.com> and sign up with your **GitHub** account.
2. Click **New +** → **Blueprint**.
3. Connect the `FantasyFootball` repository. If Render asks which repos it
   may access, grant it this one.
4. Pick the branch that contains the app (`claude/sleepy-tesla-633nk6`, or
   `main` after it's merged). Render finds `render.yaml` and shows one
   service, **fantasy-trade-desk**.
5. It asks for four environment values. Fill in:
   | Key | Value |
   |---|---|
   | `APP_PASSWORD` | any password you choose. Your league data is behind this. |
   | `YAHOO_CLIENT_ID` | leave blank for now |
   | `YAHOO_CLIENT_SECRET` | leave blank for now |
   | `YAHOO_REDIRECT_URI` | leave blank for now |
6. Click **Apply**. The first build takes 3–5 minutes. When it says
   **Live**, open the URL shown at the top of the service page. Your browser
   asks for a username and password: type anything for the username and
   your `APP_PASSWORD`.
7. On the Connect tab, click **Use demo league** to confirm everything works.

Write down your app's URL. You need it in the next step.

## 2. Create the Yahoo developer app

1. Go to <https://developer.yahoo.com/apps/create/> signed in with the **same
   Yahoo account** you use for fantasy.
2. Fill in:
   | Field | Value |
   |---|---|
   | Application Name | anything, e.g. `Trade Desk` |
   | OAuth Client Type | **Confidential Client** |
   | Homepage URL | your Render URL, e.g. `https://fantasy-trade-desk.onrender.com` |
   | Redirect URI(s) | your Render URL followed by `/auth/yahoo/callback`, e.g. `https://fantasy-trade-desk.onrender.com/auth/yahoo/callback` |
   | API Permissions | tick **Fantasy Sports** → **Read** |
3. Click **Create App**. Yahoo shows a **Client ID** and a **Client Secret**.
   Keep the page open.

## 3. Give Render the Yahoo values

1. Back in Render, open the **fantasy-trade-desk** service → **Environment**.
2. Fill in:
   | Key | Value |
   |---|---|
   | `YAHOO_CLIENT_ID` | the Client ID from Yahoo |
   | `YAHOO_CLIENT_SECRET` | the Client Secret from Yahoo |
   | `YAHOO_REDIRECT_URI` | exactly the Redirect URI you gave Yahoo |
3. Click **Save Changes**. Render redeploys (about a minute).

## 4. Connect your league

1. Open your app URL → **Connect** tab → **Connect Yahoo**.
2. Yahoo asks you to approve read access, then sends you straight back to
   the app. Pick your league and your team.

That's it. The app reads your league fresh every time you open it (cached
15 minutes).

## Things to know

* **Free tier sleeps.** After 15 minutes idle, Render pauses the app; the next
  visit takes 30–60 seconds to wake up and reload player data. Normal.
* **Reconnecting.** Render's free disk is wiped on each deploy, so after a
  redeploy you may need to click **Connect Yahoo** again. It takes one click.
* **Password.** Never share the URL without the password; anyone with both can
  see your league and act as your Yahoo read-only session.
* **Errors from Yahoo** include the endpoint and raw response. Copy them into
  the Claude session to get a fix.
