import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  yahooClientId: process.env.YAHOO_CLIENT_ID ?? "",
  yahooClientSecret: process.env.YAHOO_CLIENT_SECRET ?? "",
  yahooRedirectUri: process.env.YAHOO_REDIRECT_URI ?? "",
  isProd: process.env.NODE_ENV === "production",
};
