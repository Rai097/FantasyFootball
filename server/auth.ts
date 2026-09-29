// Yahoo OAuth routes. Mount at the app root: `app.use(authRouter)`.
//   GET  /auth/yahoo/start            → { url, mode }   (mode "oob": Yahoo shows a code to paste back)
//   POST /auth/yahoo/code  {code}     → { ok: true }
//   GET  /auth/yahoo/callback?code=   → 302 /?connected=1   (only when YAHOO_REDIRECT_URI is set)
//   POST /auth/yahoo/disconnect       → { ok: true }
// Errors: { error, hint? } with a 4xx/5xx status.
import express, { type NextFunction, type Request, type Response } from "express";
import { yahoo, YahooError } from "./providers/yahoo.js";

export const authRouter = express.Router();
authRouter.use(express.json());

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (h: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => h(req, res))
    .catch(next);
};

authRouter.get(
  "/auth/yahoo/start",
  wrap((_req, res) => {
    res.json({ url: yahoo.authUrl(), mode: yahoo.authMode() });
  }),
);

authRouter.post(
  "/auth/yahoo/code",
  wrap(async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!code.trim()) throw new YahooError("Missing code.", 400, "Paste the code Yahoo showed you after you clicked Agree.");
    await yahoo.exchangeCode(code);
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/auth/yahoo/callback",
  wrap(async (req, res) => {
    const err = typeof req.query.error === "string" ? req.query.error : "";
    if (err) {
      const desc = typeof req.query.error_description === "string" ? req.query.error_description : err;
      throw new YahooError(`Yahoo authorization was not granted: ${desc}`, 400, "Click Connect Yahoo again and choose Agree.");
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) throw new YahooError("Missing ?code= in Yahoo callback.", 400, "Start again from the Connect tab.");
    await yahoo.exchangeCode(code);
    res.redirect("/?connected=1");
  }),
);

authRouter.post(
  "/auth/yahoo/disconnect",
  wrap(async (_req, res) => {
    await yahoo.disconnect();
    res.json({ ok: true });
  }),
);

// Router-level error handler (also catches malformed JSON bodies from express.json()).
authRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof YahooError) {
    const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
    res.status(status).json({ error: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    return;
  }
  const e = err as { status?: number; type?: string; message?: string };
  if (e?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body is not valid JSON.", hint: 'Send {"code": "..."}.' });
    return;
  }
  const status = typeof e?.status === "number" && e.status >= 400 && e.status <= 599 ? e.status : 500;
  console.error("[auth]", err);
  res.status(status).json({ error: e?.message ?? String(err), hint: "See the server log for details." });
});
