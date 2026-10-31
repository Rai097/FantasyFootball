import express from "express";
import fs from "node:fs";
import path from "node:path";
import { AUTH_VARS, config } from "./config.js";
import { createAuth } from "./auth/routes.js";
import { SessionStore } from "./auth/sessions.js";
import { apiRouter, errorMiddleware, importPayload, PartialImportError } from "./api.js";
import { collectWithChrome } from "./autoimport/collector.js";
import { AutoImportService, autoImportConfig, setAutoImport } from "./autoimport/service.js";
import { getPlayerDb } from "./data/players.js";

// Fail closed: production without the four Discord sign-in vars would publish every league to anyone.
if (config.auth.mode === "error" || (config.isProd && config.auth.mode !== "discord")) {
  const why = config.auth.mode === "error" ? config.auth.message : "missing Discord config";
  console.error(`[server] refusing to start: ${why}. Set ${AUTH_VARS.join(", ")} (see .env.example).`);
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/healthz", (_req, res) => res.send("ok"));

async function start() {
  // Discord sign-in: sessions load once into memory; the guard runs before every /api and /auth/yahoo route.
  const a = config.auth;
  const sessions = new SessionStore();
  if (a.mode === "discord") await sessions.load();
  const auth =
    a.mode === "discord"
      ? createAuth({ mode: "discord", clientId: a.clientId, clientSecret: a.clientSecret, sessionSecret: a.sessionSecret, publicUrl: a.publicUrl, sessions })
      : createAuth({ mode: "dev", sessions });
  if (a.mode === "discord") console.log(`[auth] event=startup mode=discord public_url=${a.publicUrl} sessions=${sessions.size}`);
  else console.warn("[auth] event=startup mode=dev: no Discord config, every request is a built-in admin (development and tests only)");
  app.use(auth.guard);
  app.use(auth.router);

  // The Yahoo auth router lives in ./auth.ts (owned by the Yahoo provider); mount it when present.
  const authModule = "./auth.js";
  await import(authModule)
    .then((m: { authRouter?: express.Router }) => {
      if (m.authRouter) app.use(m.authRouter);
      else console.warn("auth router not available");
    })
    .catch((e: Error) => console.warn(`auth router not available (${e.message})`));

  app.use(apiRouter);

  if (config.isProd) {
    const dist = path.resolve(process.cwd(), "web/dist");
    const index = path.join(dist, "index.html");
    if (fs.existsSync(index)) {
      app.use(express.static(dist, { index: false, maxAge: "1h" }));
      app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => {
        // Hashed assets may be cached; the shell must always be fresh so deploys show up immediately.
        res.set("Cache-Control", "no-cache, no-store, must-revalidate");
        res.sendFile(index);
      });
    } else console.warn(`[server] ${index} not found: run \`npm run build\` first`);
  }

  app.use(errorMiddleware);

  // Auto-import (stopgap until the Yahoo API is approved; off unless AUTO_IMPORT=1 and the Chrome profile exists).
  // The scheduled run imports through the same server-side path as POST /api/import, as the admin.
  const ai = autoImportConfig(process.env);
  setAutoImport(
    await AutoImportService.create(ai, {
      collect: (signal) => collectWithChrome({ profileDir: ai.profileDir, leagueId: ai.leagueId!, signal }),
      apply: async (payload, signal) => {
        if (String(payload.leagueId) !== ai.leagueId) throw new Error(`payload is league ${String(payload.leagueId)}, expected ${ai.leagueId}`);
        const r = await importPayload(payload, { importedBy: "Auto-import", refusePartial: true, signal });
        return { teams: r.stored.teams.length };
      },
      isPartial: (e) => e instanceof PartialImportError,
    }),
  );

  // Warm the player database in the background so the first request is fast.
  getPlayerDb().catch((e: Error) => console.error(`[players] initial build failed: ${e.message}`));

  const onListen = () =>
    console.log(`[server] listening on http://${config.host ?? "localhost"}:${config.port}${config.isProd ? "" : " (API; web dev server runs separately)"}`);
  if (config.host) app.listen(config.port, config.host, onListen);
  else app.listen(config.port, onListen);
}

start();
