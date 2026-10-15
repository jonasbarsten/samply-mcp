import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { clearCimdCache } from "../../src/auth/cimd.js";
import { issueTokens, readAccessToken, readRefreshToken } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { encryptBlob, signBlob } from "../../src/crypto/blob.js";
import { pkceChallenge } from "../../src/crypto/pkce.js";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const TOKEN = "smp_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A Samply that accepts TOKEN and refuses "REVOKED" on GET /projects. */
function samplyFake(extra?: (url: string) => Response | undefined) {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ url, auth });
    const custom = extra?.(url);
    if (custom) return custom;
    if (url.endsWith("/projects")) return auth === "Bearer REVOKED" ? new Response("no", { status: 401 }) : Response.json([]);
    return new Response("unexpected " + url, { status: 500 });
  };
  return { fetchImpl, calls };
}

const future = () => Math.floor(Date.now() / 1000) + 300;

function codeFor(cfg: ReturnType<typeof testConfig>, overrides: Record<string, unknown> = {}) {
  return encryptBlob({ k: "d", st: TOKEN, cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB, exp: future(), ...overrides }, cfg.keys);
}

async function setup() {
  const samply = samplyFake();
  const cfg = testConfig({ fetch: samply.fetchImpl });
  const app = createApp(cfg);
  const reg = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB] }),
  });
  const clientId = (await reg.json()).client_id as string;
  return { app, cfg, clientId, codeBlob: codeFor(cfg), samply };
}

function form(fields: Record<string, string>) {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
}

describe("POST /token authorization_code", () => {
  it("exchanges a valid code for wrapped tokens with no-store, without calling Samply, and counts the first login once", async () => {
    const { app, cfg, clientId, codeBlob, samply } = await setup();
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = await res.json();
    expect(body.token_type).toBe("bearer");
    expect(body.expires_in).toBe(3600);
    const access = readAccessToken(cfg, body.access_token);
    expect(access.samplyToken).toBe(TOKEN);
    expect(access.anonId).toMatch(/^[0-9a-f]{32}$/);
    expect(readRefreshToken(cfg, body.refresh_token)).toEqual({ samplyToken: TOKEN, anonId: access.anonId });
    expect(samply.calls).toHaveLength(0);
    expect((await cfg.usage.globalStats()).totalUsers).toBe(1);

    const res2 = await app.request("/token", form({ grant_type: "authorization_code", code: codeFor(cfg), code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res2.status).toBe(200);
    expect((await cfg.usage.globalStats()).totalUsers).toBe(1);
  });

  it("rejects a wrong verifier, wrong redirect uri, wrong client, garbage code", async () => {
    const { app, codeBlob, clientId } = await setup();
    const base = { grant_type: "authorization_code", code: codeBlob, redirect_uri: CLAUDE_CB, client_id: clientId };
    expect((await app.request("/token", form({ ...base, code_verifier: "wrong" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", redirect_uri: "https://evil.example/cb" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", client_id: "garbage" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", code: "garbage" }))).status).toBe(400);
  });

  it("answers a JSON body with non-string fields with an OAuth error, not a crash", async () => {
    const { app, codeBlob, clientId } = await setup();
    const res = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: codeBlob, code_verifier: 123, redirect_uri: CLAUDE_CB, client_id: clientId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    for (const body of ["null", "[]", '"x"', "{bad json"]) {
      const odd = await app.request("/token", { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(odd.status).toBe(400);
      expect((await odd.json()).error).toBe("unsupported_grant_type");
    }
  });

  it("refuses an expired code, a code without exp, a signed (not encrypted) code, and a token wrapper presented as code", async () => {
    const { app, cfg, clientId } = await setup();
    const base = { grant_type: "authorization_code", code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId };
    const expired = await app.request("/token", form({ ...base, code: codeFor(cfg, { exp: Math.floor(Date.now() / 1000) - 1 }) }));
    expect(expired.status).toBe(400);
    expect((await expired.json()).error).toBe("invalid_grant");
    expect((await app.request("/token", form({ ...base, code: codeFor(cfg, { exp: undefined }) }))).status).toBe(400);
    const signed = signBlob({ k: "d", st: TOKEN, cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB, exp: future() }, cfg.keys);
    expect((await app.request("/token", form({ ...base, code: signed }))).status).toBe(400);
    const access = issueTokens(cfg, TOKEN, "anon").access_token;
    expect((await app.request("/token", form({ ...base, code: access }))).status).toBe(400);
  });

  it("refuses a code whose redirect uri belongs to another registered client", async () => {
    const { app, codeBlob } = await setup();
    const chatgpt = "https://chatgpt.com/connector_platform_oauth_redirect";
    const reg = await app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [chatgpt] }) });
    const otherClient = (await reg.json()).client_id as string;
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: otherClient }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("re-checks the allowlist, so a client signed for a redirect uri that is no longer allowed cannot redeem a code", async () => {
    const { app, cfg } = await setup();
    const evil = "https://evil.example/cb";
    const evilClient = signBlob({ k: "c", ru: [evil], n: "Evil" }, cfg.keys);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeFor(cfg, { ru: evil }), code_verifier: "verifier-123", redirect_uri: evil, client_id: evilClient }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("POST /token authorization_code with a client id metadata document", () => {
  const DOC_URL = "https://claude.ai/.well-known/mcp-client.json";

  function cimdSetup(redirectUris: string[]) {
    const doc = { client_id: DOC_URL, client_name: "Claude", redirect_uris: redirectUris };
    const samply = samplyFake((url) => (url === DOC_URL ? Response.json(doc) : undefined));
    const cfg = testConfig({ fetch: samply.fetchImpl });
    return { app: createApp(cfg), cfg, codeBlob: codeFor(cfg) };
  }

  beforeEach(() => clearCimdCache());

  it("exchanges a code for a client that published its identity", async () => {
    const { app, cfg, codeBlob } = cimdSetup([CLAUDE_CB]);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: DOC_URL }));
    expect(res.status).toBe(200);
    expect(readAccessToken(cfg, (await res.json()).access_token).samplyToken).toBe(TOKEN);
  });

  it("refuses a code whose redirect uri the document does not list", async () => {
    const { app, codeBlob } = cimdSetup(["https://chatgpt.com/connector_platform_oauth_redirect"]);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: DOC_URL }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("POST /token refresh_token", () => {
  it("checks the token with Samply on every renewal and keeps the anonymous id", async () => {
    const { app, cfg, clientId, codeBlob, samply } = await setup();
    const first = await (await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }))).json();
    const before = samply.calls.length;
    const res = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }));
    expect(res.status).toBe(200);
    expect(samply.calls.slice(before)).toEqual([{ url: "https://samply.test/api/v0/projects", auth: `Bearer ${TOKEN}` }]);
    const body = await res.json();
    expect(readAccessToken(cfg, body.access_token)).toMatchObject({ samplyToken: TOKEN, anonId: readAccessToken(cfg, first.access_token).anonId });
    expect(readRefreshToken(cfg, body.refresh_token).samplyToken).toBe(TOKEN);
  });

  it("answers invalid_grant when Samply has revoked the token, and 503 when Samply is down", async () => {
    const { app, cfg } = await setup();
    const revoked = issueTokens(cfg, "REVOKED", "anon", 0);
    const bad = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: revoked.refresh_token }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");

    const downCfg = testConfig({ fetch: async () => new Response("down", { status: 503 }) });
    const down = await createApp(downCfg).request("/token", form({ grant_type: "refresh_token", refresh_token: issueTokens(downCfg, TOKEN, "anon").refresh_token }));
    expect(down.status).toBe(503);
    expect((await down.json()).error).toBe("temporarily_unavailable");
  });

  it("rejects unknown grant types and garbage refresh tokens", async () => {
    const { app } = await setup();
    const res = await app.request("/token", form({ grant_type: "password" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
    const garbage = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: "garbage" }));
    expect(garbage.status).toBe(400);
    expect((await garbage.json()).error).toBe("invalid_grant");
  });
});
