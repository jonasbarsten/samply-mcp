import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../../src/mcp/operations.js";
import { CONFIRM } from "../../src/mcp/tools/common.js";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { connected, fakeSamply } from "./helpers.js";

type Block = { type: string; text?: string };
async function call(c: Awaited<ReturnType<typeof connected>>, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Block[])[0]?.text ?? "";
  return { isError: r.isError === true, text, json: () => JSON.parse(text) as unknown };
}

describe("gateway", () => {
  it("lists only the hot path, the gateway and the widget tools", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "ask_user_choice", "create_player", "list_comments", "list_items", "list_players", "list_projects", "samply_explore", "samply_read", "samply_write", "show_table",
    ]);
  });

  it("explores concepts, then a concept's operations with JSON Schema inputs", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    const root = (await call(c, "samply_explore", {})).json() as { concepts: Array<{ name: string; operations: string[] }> };
    expect(root.concepts.map((x) => x.name)).toEqual(Object.keys(CONCEPTS));
    expect(root.concepts.find((x) => x.name === "players")?.operations).toContain("update_player");
    const players = (await call(c, "samply_explore", { path: "players" })).json() as { operations: Array<{ name: string; kind: string; input: { properties: Record<string, unknown> } }> };
    const update = players.operations.find((o) => o.name === "update_player");
    expect(update?.kind).toBe("write");
    expect(Object.keys(update?.input.properties ?? {})).toEqual(expect.arrayContaining(["playerId", "name", "public", "options"]));
    expect((await call(c, "samply_explore", { path: "update_player" })).json()).toMatchObject({ name: "update_player", kind: "write", destructive: true });
    const bad = await call(c, "samply_explore", { path: "playerz" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Concepts: ");
  });

  it("marks the gateway tools read-only or destructive, and samply_write asks for confirmation", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    const { tools } = await c.listTools();
    const tool = (name: string) => tools.find((t) => t.name === name);
    expect(tool("samply_explore")?.annotations).toEqual({ readOnlyHint: true });
    expect(tool("samply_read")?.annotations).toEqual({ readOnlyHint: true });
    expect(tool("samply_write")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tool("samply_write")?.description).toContain(CONFIRM);
  });

  it("returns compact explore text whose schemas refuse extra keys", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    for (const concept of Object.keys(CONCEPTS)) {
      const explored = await call(c, "samply_explore", { path: concept });
      expect(explored.text.length, concept).toBeLessThan(12000);
    }
    const files = await call(c, "samply_explore", { path: "files" });
    const ops = (files.json() as { operations: Array<{ name: string; input: Record<string, unknown> }> }).operations;
    const upload = ops.find((o) => o.name === "request_upload");
    expect(upload?.input.additionalProperties).toBe(false);
    expect(upload?.input).not.toHaveProperty("$schema");
  });

  it("runs a hot-path operation through samply_read with the same result as the tool", async () => {
    const f = fakeSamply([{ match: /\/players$/, body: [{ id: "pl1", name: "Mix", projectid: "p1" }] }]);
    const c = await connected(f.fetchImpl);
    const direct = await call(c, "list_players", {});
    const viaGateway = await call(c, "samply_read", { operation: "list_players", args: {} });
    expect(viaGateway.isError).toBe(false);
    expect(viaGateway.text).toBe(direct.text);
  });

  it("runs a read through samply_read and counts it under the operation's name", async () => {
    const usage = memoryUsageStore();
    const f = fakeSamply([{ match: /\/players\/pl1$/, body: { id: "pl1", name: "Mix" } }]);
    const c = await connected(f.fetchImpl, { usage });
    const r = await call(c, "samply_read", { operation: "get_player", args: { playerId: "pl1" } });
    expect(r.json()).toEqual({ id: "pl1", name: "Mix" });
    expect((await usage.userMonths("anon"))[0]?.tools).toEqual({ get_player: 1 });
  });

  it("refuses the wrong gateway, an unknown operation and bad args before any Samply call", async () => {
    const usage = memoryUsageStore();
    const f = fakeSamply([]);
    const c = await connected(f.fetchImpl, { usage });
    const wrong = await call(c, "samply_read", { operation: "update_player", args: { playerId: "pl1", name: "x" } });
    expect(wrong).toMatchObject({ isError: true, text: "update_player is a write operation; call it with samply_write." });
    const mirror = await call(c, "samply_write", { operation: "get_player", args: { playerId: "pl1" } });
    expect(mirror.text).toBe("get_player is a read operation; call it with samply_read.");
    const unknown = await call(c, "samply_read", { operation: "get_playerz", args: {} });
    expect(unknown.text).toBe('Unknown operation "get_playerz". Call samply_explore to see what exists.');
    const invalid = await call(c, "samply_read", { operation: "get_player", args: { playerId: "pl1", playerID: "pl1" } });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("Invalid arguments for get_player");
    expect(invalid.text).toContain("Expected input:");
    expect(f.calls).toHaveLength(0);
    expect((await usage.userMonths("anon"))[0]).toMatchObject({ calls: 4, errors: 4, tools: { samply_read: 3, samply_write: 1 } });
  });

  it("refuses keys outside args, and args that are not a JSON object, with a hint and no Samply call", async () => {
    const usage = memoryUsageStore();
    const f = fakeSamply([]);
    const c = await connected(f.fetchImpl, { usage });
    const hint = 'Put the operation\'s inputs under args, for example {"operation":"get_project","args":{"projectId":"..."}}.';
    const stray = await call(c, "samply_read", { operation: "get_player", playerId: "pl1" });
    expect(stray).toMatchObject({ isError: true, text: hint });
    const strayWrite = await call(c, "samply_write", { operation: "update_player", args: { playerId: "pl1" }, name: "x" });
    expect(strayWrite).toMatchObject({ isError: true, text: hint });
    const badString = await call(c, "samply_read", { operation: "get_player", args: "{playerId: pl1}" });
    expect(badString).toMatchObject({ isError: true, text: hint });
    expect(f.calls).toHaveLength(0);
    expect((await usage.userMonths("anon"))[0]).toMatchObject({ calls: 3, errors: 3, tools: { samply_read: 2, samply_write: 1 } });
  });

  it("accepts args given as a JSON string", async () => {
    const f = fakeSamply([{ match: /\/players\/pl1$/, body: { id: "pl1" } }]);
    const c = await connected(f.fetchImpl);
    const r = await call(c, "samply_read", { operation: "get_player", args: '{"playerId":"pl1"}' });
    expect(r.isError).toBe(false);
    expect(r.json()).toEqual({ id: "pl1" });
  });

  it("advertises samply_read and samply_write as strict at the top level, with args an object", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    const { tools } = await c.listTools();
    for (const name of ["samply_read", "samply_write"]) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as { additionalProperties?: unknown; properties: Record<string, { type?: string }> };
      expect(schema.additionalProperties, name).toBe(false);
      expect(schema.properties.args?.type, name).toBe("object");
    }
  });

  it("tells the model that only listed tools can be called by name", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    const usage = (await call(c, "samply_explore", {})).json() as { usage: string };
    expect(usage.usage).toContain("only the tools in your tool list can be called by name");
  });

  it("runs a write through samply_write with the write guard", async () => {
    const session = { samplyUnauthorized: false, wrote: false };
    const f = fakeSamply([{ match: /\/players\/pl1$/, method: "POST", body: { id: "pl1", name: "Renamed", public: true } }]);
    const c = await connected(f.fetchImpl, { session });
    const r = await call(c, "samply_write", { operation: "update_player", args: { playerId: "pl1", name: "Renamed" } });
    expect(r.isError).toBe(false);
    expect(r.json()).toEqual({ id: "pl1", name: "Renamed", public: true });
    expect(f.calls[0]).toMatchObject({ method: "POST", body: { name: "Renamed" } });
    expect(session.wrote).toBe(true);
  });
});
