import "dotenv/config";

export const AUTH_VARS = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "SESSION_SECRET", "PUBLIC_URL"] as const;

export type AuthConfig =
  | { mode: "discord"; clientId: string; clientSecret: string; sessionSecret: string; publicUrl: string }
  | { mode: "dev" }
  | { mode: "error"; message: string };

/**
 * Discord sign-in config (docs/DESIGN.md "Discord sign-in, multi-tenant"). Production needs all four vars
 * (fail closed). Outside production, no DISCORD_CLIENT_ID = dev mode (every request is a built-in admin);
 * a partial config is an error rather than a silent fallback.
 */
export function authConfig(env: NodeJS.ProcessEnv, isProd: boolean): AuthConfig {
  const missing = AUTH_VARS.filter((k) => !env[k]);
  if (!isProd && !env.DISCORD_CLIENT_ID) return { mode: "dev" };
  if (missing.length) return { mode: "error", message: `missing ${missing.join(", ")}` };
  if (env.SESSION_SECRET!.length < 32) return { mode: "error", message: "SESSION_SECRET must be at least 32 characters (e.g. openssl rand -hex 32)" };
  let url: URL;
  try {
    url = new URL(env.PUBLIC_URL!);
  } catch {
    return { mode: "error", message: "PUBLIC_URL is not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { mode: "error", message: "PUBLIC_URL must be http(s)" };
  if (isProd && url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return { mode: "error", message: "PUBLIC_URL must be https in production" };
  return { mode: "discord", clientId: env.DISCORD_CLIENT_ID!, clientSecret: env.DISCORD_CLIENT_SECRET!, sessionSecret: env.SESSION_SECRET!, publicUrl: url.origin + url.pathname.replace(/\/+$/, "") };
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
