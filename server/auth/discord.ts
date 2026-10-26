// Discord OAuth2 client (authorization-code grant, scope `identify`).
// Docs: https://discord.com/developers/docs/topics/oauth2#authorization-code-grant
//       https://discord.com/developers/docs/resources/user#get-current-user
// Two calls: the form-encoded token exchange and GET /users/@me. Tests inject a fake with the same shape.
// Failures return null (a failed sign-in, never a 500); nothing here logs tokens or codes.

export const DISCORD_API = "https://discord.com/api";
export const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TIMEOUT_MS = 15_000;

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordClient {
  exchange(code: string, redirectUri: string): Promise<string | null>;
  me(accessToken: string): Promise<DiscordUser | null>;
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "identify", state });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

/** CDN avatar URL, only for a well-formed avatar hash. */
export function avatarUrl(uid: string, avatar: string | null | undefined): string | null {
  return avatar && /^(a_)?[0-9a-f]{32}$/.test(avatar) && /^\d+$/.test(uid) ? `https://cdn.discordapp.com/avatars/${uid}/${avatar}.png?size=64` : null;
}

export function discordClient(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): DiscordClient {
  return {
    async exchange(code, redirectUri) {
      const res = await fetchImpl(`${DISCORD_API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 200) return null;
      const tok = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
      return tok && typeof tok.access_token === "string" && tok.access_token ? tok.access_token : null;
    },
    async me(accessToken) {
      const res = await fetchImpl(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 200) return null;
      const u = (await res.json().catch(() => null)) as Partial<DiscordUser> | null;
      if (!u || typeof u.id !== "string" || !/^\d{5,25}$/.test(u.id)) return null;
      return {
        id: u.id,
        username: typeof u.username === "string" ? u.username : u.id,
        global_name: typeof u.global_name === "string" ? u.global_name : null,
        avatar: typeof u.avatar === "string" ? u.avatar : null,
      };
    },
  };
}
