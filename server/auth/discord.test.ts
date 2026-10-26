import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, avatarUrl, discordClient } from "./discord.js";

test("authorizeUrl: identify scope, code flow, redirect and state", () => {
  const u = new URL(authorizeUrl("cid", "https://ff.example/auth/callback", "st.ate"));
  assert.equal(u.origin + u.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(u.searchParams.get("scope"), "identify");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("redirect_uri"), "https://ff.example/auth/callback");
  assert.equal(u.searchParams.get("state"), "st.ate");
  assert.equal(u.searchParams.get("client_id"), "cid");
});

test("exchange: form-encoded POST to /oauth2/token; me: Bearer GET /users/@me", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", token_type: "Bearer" }), { status: 200 });
    return new Response(JSON.stringify({ id: "123456789", username: "u", global_name: "U", avatar: "a".repeat(32) }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = discordClient("cid", "csecret", fake);
  assert.equal(await c.exchange("code1", "https://ff.example/auth/callback"), "tok");
  const body = new URLSearchParams(String(calls[0].init.body));
  assert.equal(calls[0].url, "https://discord.com/api/oauth2/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "code1");
  assert.equal(body.get("client_secret"), "csecret");
  assert.ok(calls[0].init.signal, "has a timeout signal");
  const me = await c.me("tok");
  assert.equal(calls[1].url, "https://discord.com/api/users/@me");
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.deepEqual(me, { id: "123456789", username: "u", global_name: "U", avatar: "a".repeat(32) });
});

test("non-200 or malformed responses → null", async () => {
  const bad = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  assert.equal(await discordClient("a", "b", bad).exchange("c", "r"), null);
  assert.equal(await discordClient("a", "b", bad).me("t"), null);
  const weird = (async () => new Response(JSON.stringify({ id: "not-digits" }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await discordClient("a", "b", weird).me("t"), null);
  assert.equal(await discordClient("a", "b", weird).exchange("c", "r"), null);
});

test("avatarUrl only for a well-formed hash", () => {
  assert.match(avatarUrl("123", "a".repeat(32)) ?? "", /^https:\/\/cdn\.discordapp\.com\/avatars\/123\//);
  assert.equal(avatarUrl("123", "../x"), null);
  assert.equal(avatarUrl("123", null), null);
});
