import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { apiRouter, errorMiddleware } from "./api.js";
import { getPlayerDb } from "./data/players.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

async function start() {
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
      app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => res.sendFile(index));
    } else console.warn(`[server] ${index} not found: run \`npm run build\` first`);
  }

  app.use(errorMiddleware);

  // Warm the player database in the background so the first request is fast.
  getPlayerDb().catch((e: Error) => console.error(`[players] initial build failed: ${e.message}`));

  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}${config.isProd ? "" : " (API; web dev server runs separately)"}`);
  });
}

start();
