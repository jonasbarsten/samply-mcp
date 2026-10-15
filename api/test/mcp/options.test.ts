import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../../src/mcp/operations.js";
import { type ConnectorOptions, parseConnectorOptions, visibleOperations } from "../../src/mcp/options.js";
import { OPERATIONS } from "../../src/mcp/registry.js";
import { connected, fakeSamply, mentionedOperations, operationTexts } from "./helpers.js";

function parsed(segment: string): ConnectorOptions {
  const r = parseConnectorOptions(segment);
  if (!("ok" in r)) throw new Error(r.error);
  return r.ok;
}

describe("connector options", () => {
  it("parses readonly and concepts, and names an unknown word", () => {
    expect(parseConnectorOptions("")).toEqual({ ok: { readOnly: false } });
    expect(parseConnectorOptions("readonly")).toEqual({ ok: { readOnly: true } });
    const both = parseConnectorOptions("Players, files,readonly");
    expect("ok" in both && both.ok.readOnly).toBe(true);
    expect("ok" in both && [...(both.ok.concepts ?? [])].sort()).toEqual(["files", "players"]);
    const bad = parseConnectorOptions("playerz");
    expect("error" in bad && bad.error).toMatch(/^Unknown connector option "playerz"\. Use readonly and any of: /);
  });

  it("readonly hides every write; a concept filter limits writes only, and every read stays", () => {
    const reads = OPERATIONS.filter((o) => o.kind === "read").map((o) => o.name);
    const ro = visibleOperations(parsed("readonly"));
    expect(ro.map((o) => o.name)).toEqual(reads);
    const players = visibleOperations(parsed("players"));
    expect(players.filter((o) => o.kind === "read").map((o) => o.name)).toEqual(reads);
    expect(new Set(players.filter((o) => o.kind === "write").map((o) => o.concept))).toEqual(new Set(["players"]));
    expect(players.map((o) => o.name)).not.toContain("create_comment");
    expect(visibleOperations(parsed("comments")).map((o) => o.name)).toContain("create_comment");
    expect(visibleOperations(parsed("players,readonly")).map((o) => o.name)).toEqual(reads);
  });

  it("keeps visible every operation a visible operation says an id comes from, under every single-concept filter", () => {
    const names = OPERATIONS.map((o) => o.name);
    for (const segment of Object.keys(CONCEPTS)) {
      const visible = new Set(visibleOperations(parsed(segment)).map((o) => o.name));
      for (const op of OPERATIONS.filter((o) => visible.has(o.name))) {
        for (const text of operationTexts(op)) {
          for (const [, clause] of text.matchAll(/(?<![a-z_])from ([^.;]*)/g)) {
            for (const { name } of mentionedOperations(clause!, names)) {
              // A write may name another write as a source (delete_webhook takes its id from create_webhook); writes hide together.
              if (op.kind === "write" && op.concept === segment) continue;
              expect(visible.has(name), `/mcp/${segment}: ${op.name} takes an id from ${name}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it("a readonly server lists no writing tool and refuses a write through the gateway", async () => {
    const full = await connected(fakeSamply([]).fetchImpl);
    const fullExplore = await full.callTool({ name: "samply_explore", arguments: { path: "players" } });
    expect((fullExplore.content as Array<{ text: string }>)[0]?.text).toContain('"kind":"write"');

    const f = fakeSamply([]);
    const c = await connected(f.fetchImpl, { options: { readOnly: true } });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("samply_write");
    expect(names).not.toContain("create_player");
    expect(names).toContain("ask_user_choice");
    expect(names).toContain("show_table");
    const explore = await c.callTool({ name: "samply_explore", arguments: { path: "players" } });
    expect((explore.content as Array<{ text: string }>)[0]?.text).not.toContain('"kind":"write"');
    const root = (await c.callTool({ name: "samply_explore", arguments: {} })).content as Array<{ text: string }>;
    const usage = JSON.parse(root[0]!.text).usage as string;
    expect(usage).toContain("samply_read");
    expect(usage).not.toContain("samply_write");
    const r = await c.callTool({ name: "samply_read", arguments: { operation: "update_player", args: { playerId: "x", name: "y" } } });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});
