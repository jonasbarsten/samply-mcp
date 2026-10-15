import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../../src/mcp/operations.js";
import { OPERATIONS, getOperation } from "../../src/mcp/registry.js";
import { HOT_PATH } from "../../src/mcp/server.js";
import { connected, fakeSamply, mentionedOperations, operationTexts } from "./helpers.js";

const EXPECTED = [
  "list_projects", "get_project", "create_project", "update_project",
  "list_items", "get_item", "get_download_url", "request_upload", "create_folder", "create_stack", "update_item",
  "list_players", "get_player", "create_player", "update_player",
  "list_comments", "create_comment",
  "create_webhook", "delete_webhook",
  "my_usage",
];

describe("operation registry", () => {
  it("holds every operation once, with a known concept and a plain name", () => {
    expect([...OPERATIONS.map((o) => o.name)].sort()).toEqual([...EXPECTED].sort());
    for (const op of OPERATIONS) {
      expect(op.name).toMatch(/^[a-z_]+$/);
      expect(Object.keys(CONCEPTS)).toContain(op.concept);
      expect(getOperation(op.name)).toBe(op);
      if (op.kind === "read") expect(op.destructive).toBe(false);
    }
    expect(getOperation("nope")).toBeUndefined();
    expect(OPERATIONS.map((o) => o.name).filter((n) => n.startsWith("delete_"))).toEqual(["delete_webhook"]);
  });

  it("marks consequential writes and asks for confirmation in them", () => {
    // Easy to undo in Samply, and visible to nobody else: not destructive.
    const notDestructive = ["create_project", "request_upload", "create_folder", "create_stack", "create_webhook"];
    for (const op of OPERATIONS.filter((o) => o.kind === "write")) {
      expect(op.destructive, op.name).toBe(!notDestructive.includes(op.name));
      if (op.destructive) expect(op.description, op.name).toContain("Consequential");
    }
  });

  it("names the gateway wherever a text names an operation that is not a tool of its own", () => {
    const names = OPERATIONS.map((o) => o.name);
    for (const op of OPERATIONS) {
      for (const text of operationTexts(op)) {
        for (const { name, index } of mentionedOperations(text, names)) {
          if (name === op.name || (HOT_PATH as readonly string[]).includes(name)) continue;
          const after = text.slice(index + name.length, index + name.length + 60);
          expect(after, `${op.name} mentions ${name} in "${text}"`).toMatch(/samply_read|samply_write/);
        }
      }
    }
  });

  it("registers the hot-path operations as tools with their annotations, and no other operation", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    const { tools } = await c.listTools();
    for (const op of OPERATIONS) {
      const tool = tools.find((t) => t.name === op.name);
      if (!(HOT_PATH as readonly string[]).includes(op.name)) {
        expect(tool, op.name).toBeUndefined();
        continue;
      }
      expect(tool, op.name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, op.name).toBe(op.kind === "read");
      if (op.kind === "write") expect(tool?.annotations?.destructiveHint, op.name).toBe(op.destructive);
    }
  });
});
