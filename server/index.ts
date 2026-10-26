import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { apiRouter, errorMiddleware } from "./api.js";
import { getPlayerDb } from "./data/players.js";

// Fail closed: a production server without a password would publish the owner's league to anyone with the URL.
if (config.isProd && !process.env.APP_PASSWORD) {
  console.error("[server] refusing to start: NODE_ENV=production requires APP_PASSWORD (set it in .env or the host's environment).");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/healthz", (_req, res) => res.send("ok"));

// Optional password gate for hosted deployments: set APP_PASSWORD to require
// HTTP Basic auth (any username) on every route.
if (process.env.APP_PASSWORD) {
  const expected = process.env.APP_PASSWORD;
  app.use((req, res, next) => {
    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (pass === expected) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Trade Desk"');
    res.status(401).send("Password required");
  });
}

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
      app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => {
        // Hashed assets may be cached; the shell must always be fresh so deploys show up immediately.
        res.set("Cache-Control", "no-cache, no-store, must-revalidate");
        res.sendFile(index);
      });
    } else console.warn(`[server] ${index} not found: run \`npm run build\` first`);
  }

  app.use(errorMiddleware);

  // Warm the player database in the background so the first request is fast.
  getPlayerDb().catch((e: Error) => console.error(`[players] initial build failed: ${e.message}`));

  const onListen = () =>
    console.log(`[server] listening on http://${config.host ?? "localhost"}:${config.port}${config.isProd ? "" : " (API; web dev server runs separately)"}`);
  if (config.host) app.listen(config.port, config.host, onListen);
  else app.listen(config.port, onListen);
}

start();
