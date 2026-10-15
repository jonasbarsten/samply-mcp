import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { issueTokens } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";

let samplyCalls = 0;
const cfg = testConfig({
  fetch: async (input) => {
    samplyCalls++;
    if (String(input).endsWith("/projects")) return Response.json([{ id: "p1", name: "Album", object: "project", size: 10, timeCreated: 1_700_000_000_000 }]);
    return new Response("unexpected", { status: 500 });
  },
});
const app = createApp(cfg);
const token = issueTokens(cfg, "SAMPLY-TOKEN", "anon").access_token;

function rpc(body: unknown, auth = `Bearer ${token}`, target = app, path = "/mcp") {
  return target.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}
const listProjects = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_projects", arguments: {} } });

describe("POST /mcp", () => {
  it("rejects missing and invalid bearer tokens before doing any work", async () => {
    const before = samplyCalls;
    const missing = await rpc(listProjects(1), "");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer error="invalid_token", resource_metadata="https://samply-mcp.test/.well-known/oauth-protected-resource"');
    const bad = await rpc(listProjects(1), "Bearer nope");
    expect(bad.status).toBe(401);
    expect(samplyCalls).toBe(before);
  });

  it("answers initialize and tools/call as JSON, with the icon and instructions", async () => {
    const init = await rpc({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    const result = (await init.json()).result;
    expect(result.serverInfo.name).toBe("samply-mcp");
    expect(result.serverInfo.icons).toEqual([{ src: "https://samply-mcp.test/icon.png", mimeType: "image/png", sizes: ["512x512"] }]);
    expect(result.instructions).toContain("ask_user_choice");

    const call = await rpc(listProjects(2));
    expect(call.status).toBe(200);
    const body = await call.json();
    expect(JSON.parse(body.result.content[0].text)).toEqual([{ id: "p1", name: "Album", size: 10, timeCreated: "2023-11-14T22:13:20.000Z" }]);
  });

  it("returns 405 for GET and DELETE", async () => {
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await app.request("/mcp", { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  it("still answers 200 with isError when a tool call fails with a non-auth Samply error", async () => {
    const call = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_players", arguments: {} } });
    expect(call.status).toBe(200);
    expect((await call.json()).result.isError).toBe(true);
  });

  it("answers 200 with a tool error when Samply refuses one endpoint but /projects confirms the login", async () => {
    const cfgEndpoint = testConfig({
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/players")) return new Response("no access", { status: 403 });
        if (url.endsWith("/projects")) return Response.json([]);
        return new Response("unexpected", { status: 500 });
      },
    });
    const appEndpoint = createApp(cfgEndpoint);
    const tok = issueTokens(cfgEndpoint, "SAMPLY-TOKEN", "anon").access_token;
    const res = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_players", arguments: {} } }, `Bearer ${tok}`, appEndpoint);
    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("although the login is valid: no access");
  });

  it("turns a Samply 401 during a tool call into an HTTP 401 so the client refreshes, when /projects answers 401 too", async () => {
    const cfg401 = testConfig({ fetch: async () => new Response("expired", { status: 401 }) });
    const app401 = createApp(cfg401);
    const tok = issueTokens(cfg401, "SAMPLY-TOKEN", "anon").access_token;
    const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_players", arguments: {} } }, `Bearer ${tok}`, app401);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("does not answer 401 for a write that succeeded before a later refusal in the same request", async () => {
    let n = 0;
    const cfgWrite = testConfig({
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/players") && init?.method === "POST") return Response.json({ id: "pl1", name: "Mix" });
        if (url.endsWith("/projects")) return n++ === 0 ? new Response("expired", { status: 401 }) : new Response("expired", { status: 401 });
        return new Response("unexpected", { status: 500 });
      },
    });
    const appWrite = createApp(cfgWrite);
    const tok = issueTokens(cfgWrite, "SAMPLY-TOKEN", "anon").access_token;
    // Nothing written yet: the refusal is confirmed and becomes HTTP 401.
    const first = await rpc(listProjects(5), `Bearer ${tok}`, appWrite);
    expect(first.status).toBe(401);
    // A write succeeded in this request; a later refusal must stay a tool error so the client cannot repeat the write.
    const created = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "create_player", arguments: { name: "Mix", projectId: "p1" } } }, `Bearer ${tok}`, appWrite);
    expect(created.status).toBe(200);
    expect((await created.json()).result.isError).toBeFalsy();
  });

  it("serves option paths: a 401 points at their own metadata, an unknown option is a 400", async () => {
    const unauth = await app.request("/mcp/readonly", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toBe('Bearer error="invalid_token", resource_metadata="https://samply-mcp.test/.well-known/oauth-protected-resource/mcp/readonly"');
    const bad = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, `Bearer ${token}`, app, "/mcp/playerz");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_connector_options");
    const unauthBad = await app.request("/mcp/playerz", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(unauthBad.status).toBe(401);
    expect(unauthBad.headers.get("www-authenticate")).toBe('Bearer error="invalid_token", resource_metadata="https://samply-mcp.test/.well-known/oauth-protected-resource"');
    const ro = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, `Bearer ${token}`, app, "/mcp/readonly");
    const names = ((await ro.json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("samply_read");
    expect(names).not.toContain("samply_write");
    expect(names).not.toContain("create_player");
  });

  it("accepts a comma sent as %2C and refuses malformed percent-encoding as an invalid option", async () => {
    const list = (path: string) => rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, `Bearer ${token}`, app, path);
    const encoded = await list("/mcp/files%2Creadonly");
    expect(encoded.status).toBe(200);
    const names = ((await encoded.json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("samply_read");
    expect(names).not.toContain("samply_write");
    const malformed = await list("/mcp/readonly%E0%A4%A");
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("invalid_connector_options");
  });

  it("refuses a legacy JSON-RPC batch body with 400 and makes no Samply call", async () => {
    const before = samplyCalls;
    const res = await rpc([listProjects(1)]);
    expect(res.status).toBe(400);
    expect(samplyCalls).toBe(before);
  });
});
