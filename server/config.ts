import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Interface to bind (e.g. 127.0.0.1 behind a tunnel); unset = all interfaces. */
  host: process.env.HOST || undefined,
  yahooClientId: process.env.YAHOO_CLIENT_ID ?? "",
  yahooClientSecret: process.env.YAHOO_CLIENT_SECRET ?? "",
  yahooRedirectUri: process.env.YAHOO_REDIRECT_URI ?? "",
  isProd: process.env.NODE_ENV === "production",
};
