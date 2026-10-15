import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { clearCimdCache } from "../../src/auth/cimd.js";
import { testConfig } from "../../src/config.js";
import { decryptBlob, keyRingFromParameter, signBlob } from "../../src/crypto/blob.js";
import { pkceChallenge } from "../../src/crypto/pkce.js";

const TOKEN = "smp_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

/** A Samply that accepts exactly TOKEN on GET /projects; everything else is 500 unless `other` says otherwise. */
function samplyFake(other?: (url: string) => Response | undefined) {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ url, auth });
    const custom = other?.(url);
    if (custom) return custom;
    if (url.endsWith("/projects")) return auth === `Bearer ${TOKEN}` ? Response.json([]) : new Response("bad token", { status: 401 });
    return new Response("unexpected " + url, { status: 500 });
  };
  return { fetchImpl, calls };
}

const samply = samplyFake();
const cfg = testConfig({ fetch: samply.fetchImpl });
const app = createApp(cfg);

async function register(name = "Claude <b>x</b>", target = app) {
  const res = await target.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [CLAUDE_CB] }),
  });
  return (await res.json()).client_id as string;
}

function params(clientId: string, overrides: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CB,
    code_challenge: pkceChallenge("verifier-123"),
    code_challenge_method: "S256",
    state: "client-state",
    ...overrides,
  };
}

const LOGIN_COOKIE = "__Host-smcp_login";

/** Parses the login cookie's value out of a Set-Cookie header. */
function loginCookieValue(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`(?:^|, ?)${LOGIN_COOKIE}=([^;]*)`).exec(header);
  return m?.[1] ?? "";
}

const get = (p: Record<string, string>, target = app) => target.request(`/authorize?${new URLSearchParams(p)}`);
const post = (p: Record<string, string>, cookie?: string, target = app) =>
  target.request("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(p).toString(),
  });

/** What a browser holds after viewing the consent page: the login cookie and the nonce field the form will echo. */
async function consent(p: Record<string, string>, target = app) {
  const res = await get(p, target);
  const html = await res.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { res, html, nonce, cookie: `${LOGIN_COOKIE}=${loginCookieValue(res)}` };
}

/** Presses "Connect" the way a browser does: consent page first, then the form post with cookie, nonce and token. */
async function pressConnect(p: Record<string, string>, token = TOKEN, target = app) {
  const seen = await consent(p, target);
  return { seen, res: await post({ ...p, nonce: seen.nonce, samply_token: token }, seen.cookie, target) };
}

/** The client URL the continue page navigates to, from its meta refresh. */
function backUrlFrom(html: string): URL {
  const m = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html);
  if (!m) throw new Error("no meta refresh in continue page");
  return new URL(m[1]!.replace(/&amp;/g, "&"));
}

describe("GET /authorize (consent)", () => {
  it("renders a login page naming the client and Samply's token page, with the parameters as hidden fields, escaped", async () => {
    const res = await get(params(await register()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Claude (claude.ai)");
    expect(html).toContain("Claude &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('name="code_challenge"');
    expect(html).toContain('action="/authorize"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="samply_token"');
    expect(html).toContain("https://samply.test/preferences/api");
    expect(html).toContain("error=access_denied");
    expect(html).toContain("state=client-state");
    expect(html).not.toContain("javascript:");
  });

  it("issues the login nonce as a __Host- cookie and as a hidden field", async () => {
    const { res, html, nonce } = await consent(params(await register()));
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(html).toContain(`name="nonce" value="${nonce}"`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${LOGIN_COOKIE}=${nonce}; `));
    for (const attr of ["Max-Age=3600", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(attr);
    expect(cookie).not.toMatch(/Domain=/i);
    const again = await consent(params(await register()));
    expect(again.nonce).not.toBe(nonce);
  });

  it("does not repeat the client name when the label already says it", async () => {
    const html = await (await get(params(await register("Claude")))).text();
    expect(html).toContain("<strong>Claude (claude.ai)</strong>");
    expect(html).not.toContain("via");
  });

  it("rejects an unregistered redirect uri, a bad client id and a missing challenge", async () => {
    expect((await get(params(await register(), { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }))).status).toBe(400);
    expect((await get(params("garbage"))).status).toBe(400);
    expect((await get(params(await register(), { code_challenge_method: "plain" }))).status).toBe(400);
  });

  it("accepts a loopback redirect on any port when the client registered it without one (ChatGPT Desktop)", async () => {
    const res = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Codex", redirect_uris: ["http://127.0.0.1/callback/abc"] }),
    });
    const clientId = (await res.json()).client_id as string;
    expect((await get(params(clientId, { redirect_uri: "http://127.0.0.1:61234/callback/abc" }))).status).toBe(200);
    expect((await get(params(clientId, { redirect_uri: "http://127.0.0.1:61234/callback/other" }))).status).toBe(400);
  });

  it("re-checks the allowlist, so a client id signed for a redirect uri that is no longer allowed is refused", async () => {
    const evil = "https://evil.example/cb";
    const clientId = signBlob({ k: "c", ru: [evil], n: "Evil" }, cfg.keys);
    expect((await get(params(clientId, { redirect_uri: evil }))).status).toBe(400);
    expect((await post(params(clientId, { redirect_uri: evil }))).status).toBe(400);
  });

  it("refuses a client id signed under a kid that is not in the ring", async () => {
    const otherRing = keyRingFromParameter(`t9:${"9".repeat(64)}`);
    const clientId = signBlob({ k: "c", ru: [CLAUDE_CB], n: "x" }, otherRing);
    expect((await get(params(clientId))).status).toBe(400);
  });
});

describe("POST /authorize", () => {
  it("checks the token with Samply, then sends the browser back to the client with an encrypted five-minute code", async () => {
    const before = samply.calls.length;
    const { res } = await pressConnect(params(await register()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // A page, not a redirect: Chrome would check a redirect chain against form-action.
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self';");
    const html = await res.text();
    expect(html).toContain("Click here if nothing happens");
    expect(html).not.toContain(TOKEN);
    const back = backUrlFrom(html);
    expect(back.origin + back.pathname).toBe(CLAUDE_CB);
    expect(back.searchParams.get("state")).toBe("client-state");
    const codeParam = back.searchParams.get("code")!;
    expect(codeParam.startsWith("v1e.")).toBe(true);
    expect(codeParam).not.toContain(TOKEN);
    const code = decryptBlob<Record<string, unknown>>(codeParam, cfg.keys);
    expect(code).toMatchObject({ k: "d", st: TOKEN, cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB });
    expect(code.exp as number).toBeLessThan(Date.now() / 1000 + 301);
    const check = samply.calls.slice(before).filter((c) => c.url.endsWith("/projects"));
    expect(check).toHaveLength(1);
    expect(check[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toMatch(new RegExp(`^${LOGIN_COOKIE}=; `));
    expect(cleared).toContain("Max-Age=0");
  });

  it("trims the pasted token", async () => {
    const { res } = await pressConnect(params(await register()), `  ${TOKEN}\n`);
    expect(res.status).toBe(200);
    const code = decryptBlob<Record<string, unknown>>(backUrlFrom(await res.text()).searchParams.get("code")!, cfg.keys);
    expect(code.st).toBe(TOKEN);
  });

  it("shows the page again with an error, and a fresh nonce, when Samply refuses the token; never calls Samply with an implausible one", async () => {
    const before = samply.calls.length;
    const { res, seen } = await pressConnect(params(await register()), "smp_WRONG-TOKEN-VALUE-00000");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Samply did not accept that token");
    expect(html).toContain('name="samply_token"');
    expect(html).not.toContain("smp_WRONG");
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(nonce).not.toBe(seen.nonce);
    expect(samply.calls.slice(before).filter((c) => c.url.endsWith("/projects"))).toHaveLength(1);

    const beforeShort = samply.calls.length;
    const short = await pressConnect(params(await register()), "short");
    expect(short.res.status).toBe(400);
    expect(await short.res.text()).toContain("Paste the personal access token");
    expect(samply.calls.length).toBe(beforeShort);
  });

  it("says when Samply could not be reached, without a 500", async () => {
    const down = samplyFake(() => new Response("down", { status: 503 }));
    const appDown = createApp(testConfig({ fetch: down.fetchImpl }));
    const clientId = await register("Claude", appDown);
    const { res } = await pressConnect(params(clientId), TOKEN, appDown);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Samply could not be reached (503)");
  });

  it("refuses a form post that does not carry the consent page's cookie and nonce (CSRF), before touching Samply", async () => {
    const p = params(await register());
    const seen = await consent(p);
    const before = samply.calls.length;
    expect((await post({ ...p, nonce: seen.nonce, samply_token: TOKEN })).status).toBe(400); // no cookie: a cross-site post under SameSite=Lax
    expect((await post({ ...p, samply_token: TOKEN }, seen.cookie)).status).toBe(400); // no field
    expect((await post({ ...p, nonce: "x".repeat(22), samply_token: TOKEN }, seen.cookie)).status).toBe(400); // wrong field
    const other = await consent(params(await register()));
    expect((await post({ ...p, nonce: seen.nonce, samply_token: TOKEN }, other.cookie)).status).toBe(400); // another browser's cookie
    expect(samply.calls.length).toBe(before);
    expect((await post({ ...p, nonce: seen.nonce, samply_token: TOKEN }, seen.cookie)).status).toBe(200);
  });

  it("re-validates everything", async () => {
    expect((await pressConnect(params("garbage"))).res.status).toBe(400);
    const p = params(await register());
    const seen = await consent(p);
    expect((await post({ ...p, redirect_uri: "https://evil.example/cb", nonce: seen.nonce, samply_token: TOKEN }, seen.cookie)).status).toBe(400);
  });
});

describe("a client id metadata document as client_id", () => {
  const DOC_URL = "https://claude.ai/.well-known/mcp-client.json";

  /** Serves the published identity document; anything else behaves like the Samply fake. */
  function serving(redirectUris: string[]) {
    const doc = { client_id: DOC_URL, client_name: "Claude", redirect_uris: redirectUris };
    const fake = samplyFake((url) => (url === DOC_URL ? Response.json(doc) : undefined));
    const cfg = testConfig({ fetch: fake.fetchImpl });
    return { cfg, app: createApp(cfg) };
  }
  const claude = serving([CLAUDE_CB]);

  beforeEach(() => clearCimdCache());

  it("renders the consent page for a published identity", async () => {
    const res = await get(params(DOC_URL), claude.app);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Claude (claude.ai)");
  });

  it("refuses a redirect uri the document does not list", async () => {
    const res = await get(params(DOC_URL, { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }), claude.app);
    expect(res.status).toBe(400);
  });

  it("re-checks our allowlist, so a document listing a redirect uri we do not allow is refused", async () => {
    const evil = "https://evil.example/cb";
    const res = await get(params(DOC_URL, { redirect_uri: evil }), serving([evil]).app);
    expect(res.status).toBe(400);
  });

  it("carries the published identity through consent and the form post", async () => {
    const { res } = await pressConnect(params(DOC_URL), TOKEN, claude.app);
    expect(res.status).toBe(200);
    const back = backUrlFrom(await res.text());
    expect(back.origin + back.pathname).toBe(CLAUDE_CB);
    expect(decryptBlob<Record<string, unknown>>(back.searchParams.get("code")!, claude.cfg.keys)).toMatchObject({ k: "d", st: TOKEN, ru: CLAUDE_CB });
  });
});
