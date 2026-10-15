import { describe, expect, it } from "vitest";
import { CHOICE_RESOURCE_URI, choiceFallback } from "../../src/mcp/tools/choice.js";
import { TABLE_RESOURCE_URI, tableFallback } from "../../src/mcp/tools/table.js";
import { connected, fakeSamply } from "./helpers.js";

describe("widget tools", () => {
  it("ask_user_choice returns a numbered fallback and the structured question, and serves one stable resource", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    const r = await c.callTool({ name: "ask_user_choice", arguments: { question: "Which project?", options: [{ label: "Album", value: "p1" }, { label: "Demos", value: "p2", description: "3 files" }] } });
    expect(r.isError).toBeFalsy();
    expect((r.content as Array<{ text: string }>)[0]?.text).toBe("Asked the user: Which project?\n1. Album\n2. Demos – 3 files\nWait for the answer in the chat.");
    expect(r.structuredContent).toEqual({ question: "Which project?", options: [{ label: "Album", value: "p1" }, { label: "Demos", value: "p2", description: "3 files" }], allowOther: false });
    const tool = (await c.listTools()).tools.find((t) => t.name === "ask_user_choice")!;
    expect(tool._meta).toMatchObject({ ui: { resourceUri: CHOICE_RESOURCE_URI } });
    expect(CHOICE_RESOURCE_URI).toBe("ui://samply-mcp/choice.html");
    const res = await c.readResource({ uri: CHOICE_RESOURCE_URI });
    expect(String((res.contents[0] as { text: string }).text).startsWith("<!doctype html>")).toBe(true);
    expect((await c.callTool({ name: "ask_user_choice", arguments: { question: "?", options: [{ label: "A", value: "a" }, { label: "B", value: "a" }] } })).isError).toBe(true);
  });

  it("show_table renders a Markdown fallback with durations and sizes, and refuses unknown cell keys", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    const args = {
      title: "Mixes",
      columns: [{ key: "name", label: "Name" }, { key: "len", label: "Length", kind: "duration" }, { key: "size", label: "Size", kind: "size" }],
      rows: [{ cells: { name: "Mix v3", len: 212, size: 52_400_000 }, actions: [{ label: "Share", message: "Share Mix v3" }] }, { cells: { name: "a|b" } }],
      note: "Two files",
    };
    const r = await c.callTool({ name: "show_table", arguments: args });
    expect(r.isError).toBeFalsy();
    expect((r.content as Array<{ text: string }>)[0]?.text).toBe(
      ["Mixes", "", "| Name | Length | Size |", "| --- | --- | --- |", "| Mix v3 | 3:32 | 52.4 MB |", "| a\\|b |  |  |", "", "Two files", "", "Actions row 1: Share"].join("\n"),
    );
    expect(TABLE_RESOURCE_URI).toBe("ui://samply-mcp/table.html");
    const bad = await c.callTool({ name: "show_table", arguments: { ...args, rows: [{ cells: { nope: "x" } }] } });
    expect(bad.isError).toBe(true);
  });

  it("fallback helpers are plain functions", () => {
    expect(choiceFallback({ question: "Q", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] })).toContain("1. A");
    expect(tableFallback({ title: "T", columns: [{ key: "k", label: "K" }], rows: [{ cells: {} }] })).toContain("| K |");
  });
});
