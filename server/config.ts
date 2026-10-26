import "dotenv/config";

export const AUTH_VARS = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "SESSION_SECRET", "PUBLIC_URL"] as const;

export type AuthConfig =
  | { mode: "discord"; clientId: string; clientSecret: string; sessionSecret: string; publicUrl: string }
  | { mode: "dev" }
  | { mode: "error"; message: string };

/** NODE_ENV values that may run without Discord (every request is a built-in admin): never the default. */
export const DEV_ENVS = new Set(["development", "test"]);

/**
 * Discord sign-in config (docs/DESIGN.md "Discord sign-in, multi-tenant"). All four vars are required (fail closed)
 * unless NODE_ENV is explicitly "development" or "test" AND no DISCORD_CLIENT_ID is set: then dev mode. An unset or
 * misspelled NODE_ENV is NOT dev mode. A partial config is an error rather than a silent fallback. Values are
 * trimmed: whitespace-only counts as missing.
 */
export function authConfig(env: NodeJS.ProcessEnv, isProd: boolean): AuthConfig {
  const v = (k: (typeof AUTH_VARS)[number]) => (env[k] ?? "").trim();
  const missing = AUTH_VARS.filter((k) => !v(k));
  if (!isProd && DEV_ENVS.has(env.NODE_ENV ?? "") && !v("DISCORD_CLIENT_ID")) return { mode: "dev" };
  if (missing.length) return { mode: "error", message: `missing ${missing.join(", ")}` };
  if (v("SESSION_SECRET").length < 32) return { mode: "error", message: "SESSION_SECRET must be at least 32 characters (e.g. openssl rand -hex 32)" };
  let url: URL;
  try {
    url = new URL(v("PUBLIC_URL"));
  } catch {
    return { mode: "error", message: "PUBLIC_URL is not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { mode: "error", message: "PUBLIC_URL must be http(s)" };
  if (isProd && url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return { mode: "error", message: "PUBLIC_URL must be https in production" };
  return { mode: "discord", clientId: v("DISCORD_CLIENT_ID"), clientSecret: v("DISCORD_CLIENT_SECRET"), sessionSecret: v("SESSION_SECRET"), publicUrl: url.origin + url.pathname.replace(/\/+$/, "") };
}

const isProd = process.env.NODE_ENV === "production";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Interface to bind (e.g. 127.0.0.1 behind a tunnel); unset = all interfaces. */
  host: process.env.HOST || undefined,
  yahooClientId: process.env.YAHOO_CLIENT_ID ?? "",
  yahooClientSecret: process.env.YAHOO_CLIENT_SECRET ?? "",
  yahooRedirectUri: process.env.YAHOO_REDIRECT_URI ?? "",
  isProd,
  auth: authConfig(process.env, isProd),
};
