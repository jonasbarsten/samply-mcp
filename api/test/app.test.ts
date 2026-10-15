import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { testConfig } from "../src/config.js";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const SECRET_BODY = "samply-answered-with-secret-details";
const TOKEN = "smp_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function captureStdout() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("app", () => {
  it("serves the connector icon publicly, as a real PNG, cacheable", async () => {
    const res = await createApp(testConfig()).request("/icon.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  afterEach(() => vi.restoreAllMocks());

  it("turns an unexpected error into a bare 500 and logs neither the body nor the token", async () => {
    // A fetch that throws something that is not a SamplyError: the one path that reaches app.onError from the login.
    const cfg = testConfig({ fetch: async () => { throw new Error(SECRET_BODY); } });
    const app = createApp(cfg);
    const reg = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CB] }),
    });
    const clientId = (await reg.json()).client_id as string;
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s" });
    const consent = await app.request(`/authorize?${q}`);
    const nonce = /name="nonce" value="([^"]+)"/.exec(await consent.text())![1]!;
    const cookie = `__Host-smcp_login=${nonce}`;

    const out = captureStdout();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ ...Object.fromEntries(q), nonce, samply_token: TOKEN }).toString(),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal error");
    expect(errorSpy).not.toHaveBeenCalled();

    const all = out.lines.join("");
    expect(all).not.toContain(SECRET_BODY);
    expect(all).not.toContain("Bearer");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(nonce);
    const events = out.json();
    expect(events.find((e) => e.event === "error")).toMatchObject({ route: "/authorize", method: "POST", name: "Error" });
    expect(events.find((e) => e.event === "request")).toMatchObject({ route: "/authorize", method: "POST", status: 500 });
  });

  it("writes one request line per request with id, method, route, status and duration", async () => {
    const app = createApp(testConfig());
    const out = captureStdout();
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/nope")).status).toBe(404);
    const events = out.json();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "request", method: "GET", route: "/", status: 200 });
    expect(events[1]).toMatchObject({ event: "request", method: "GET", route: "/nope", status: 404 });
    for (const e of events) {
      expect(typeof e.ms).toBe("number");
      expect(typeof e.requestId).toBe("string");
      expect((e.requestId as string).length).toBeGreaterThan(0);
    }
    expect(events[0]!.requestId).not.toBe(events[1]!.requestId);
  });

  it("uses the API Gateway request id when running behind the Lambda adapter", async () => {
    const app = createApp(testConfig());
    const out = captureStdout();
    await app.request("/", {}, { requestContext: { requestId: "apigw-req-1" } });
    expect(out.json()[0]).toMatchObject({ event: "request", requestId: "apigw-req-1" });
  });

  it("never logs the query string or headers, and survives a path that looks like a secret", async () => {
    const app = createApp(testConfig());
    const out = captureStdout();
    await app.request("/authorize?code=v1e.k1.aaaa.bbbb&state=v1.k1.cccc.dddd", { headers: { authorization: "Bearer topsecret", cookie: "x=1" } });
    const res = await app.request("/v1.k1.aaaa.bbbb");
    expect(res.status).toBe(404);
    const all = out.lines.join("");
    expect(all).not.toContain("topsecret");
    expect(all).not.toContain("v1.k1");
    expect(all).not.toContain("x=1");
    expect(out.json()).toHaveLength(2);
    expect(out.json()[1]).toMatchObject({ event: "request", status: 404, route: "(unloggable)" });
  });
});
