import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDuration, formatSize, tableCellText } from "../src/mcp/tools/table.js";
import { cellText, formatDuration as widgetDuration, formatSize as widgetSize, renderTable, type TableData } from "../src/widget/table.mjs";
import { FakeEl } from "./fake-dom.js";
import { runPageScript } from "./page-script.js";

const doc = { createElement: (tag: string) => new FakeEl(tag) };
const data: TableData = {
  title: "Mixes",
  columns: [
    { key: "name", label: "Name" },
    { key: "modified", label: "Modified", kind: "date" as const },
    { key: "length", label: "Length", kind: "duration" as const },
    { key: "size", label: "Size", kind: "size" as const },
  ],
  rows: [
    {
      cells: { name: "Mix v3.wav", modified: "2026-10-15", length: 212.4, size: 52_400_000, extra: "hidden" },
      actions: [
        { label: "Share", message: "Share Mix v3 with the client" },
        { label: "Comments", message: "Show the comments on Mix v3" },
      ],
    },
    { cells: { name: "<b>Mix v2</b>", length: 3725, size: 512_000 }, actions: [{ label: "Share", message: "Share Mix v2" }] },
    { cells: { name: "Idea", modified: "2026-11-01", length: 7 } },
  ],
  note: "Three files",
};

const rowButtons = (root: FakeEl, rowIndex: number) => root.all().filter((e) => e.tag === "tr")[rowIndex + 1]!.all().filter((e) => e.tag === "button");
const render = (send: (t: string) => void = () => {}, d = data) => {
  const root = new FakeEl("div");
  renderTable(doc as never, root as never, d, send);
  return root;
};

describe("table widget logic", () => {
  it("renders the title, a header from the labels and one row per item, all as text", () => {
    const root = render();
    expect(root.all().some((e) => e.textContent === "Mixes")).toBe(true);
    const headers = root.all().filter((e) => e.tag === "th").map((e) => e.textContent);
    expect(headers).toEqual(["Name", "Modified", "Length", "Size", ""]);
    expect(root.all().filter((e) => e.tag === "tr")).toHaveLength(4);
    expect(root.all().some((e) => e.textContent === "<b>Mix v2</b>")).toBe(true);
    expect(root.all().some((e) => e.textContent === "Three files")).toBe(true);
  });

  it("shows durations as m:ss, sizes in MB, dates and text as given, missing cells empty, undeclared keys never", () => {
    const root = render();
    const rows = root.all().filter((e) => e.tag === "tr").slice(1);
    const cells = (row: FakeEl) => row.children.filter((c) => c.tag === "td").map((c) => c.textContent);
    expect(cells(rows[0]!).slice(0, 4)).toEqual(["Mix v3.wav", "2026-10-15", "3:32", "52.4 MB"]);
    expect(cells(rows[1]!).slice(0, 4)).toEqual(["<b>Mix v2</b>", "", "1:02:05", "512 kB"]);
    expect(cells(rows[2]!).slice(0, 4)).toEqual(["Idea", "2026-11-01", "0:07", ""]);
    expect(root.all().some((e) => e.textContent === "hidden")).toBe(false);
  });

  it("shows a non-numeric duration or size cell as given", () => {
    expect(cellText({ key: "x", label: "x", kind: "duration" }, "abc")).toBe("abc");
    expect(cellText({ key: "x", label: "x", kind: "size" }, " ")).toBe(" ");
    expect(cellText({ key: "x", label: "x", kind: "duration" }, "90")).toBe("1:30");
  });

  it("renders one button per action, none for a row without actions", () => {
    const root = render();
    expect(rowButtons(root, 0).map((b) => b.textContent)).toEqual(["Share", "Comments"]);
    expect(rowButtons(root, 1)).toHaveLength(1);
    expect(rowButtons(root, 2)).toHaveLength(0);
  });

  it("sends an action's message once and disables only that row's buttons", () => {
    const sent: string[] = [];
    const root = render((t) => sent.push(t));
    const [share] = rowButtons(root, 0);
    share!.click();
    share!.click();
    rowButtons(root, 0)[1]!.click();
    expect(sent).toEqual(["Share Mix v3 with the client"]);
    expect(rowButtons(root, 0).every((b) => b.disabled)).toBe(true);
    expect(rowButtons(root, 1).every((b) => !b.disabled)).toBe(true);
    rowButtons(root, 1)[0]!.click();
    expect(sent).toEqual(["Share Mix v3 with the client", "Share Mix v2"]);
  });

  it("starts rows already in the acted set disabled and cannot act on them again", () => {
    const sent: string[] = [];
    const root = new FakeEl("div");
    renderTable(doc as never, root as never, data, (t: string) => sent.push(t), new Set([0]));
    expect(rowButtons(root, 0).every((b) => b.disabled)).toBe(true);
    rowButtons(root, 0)[0]!.click();
    expect(sent).toEqual([]);
    expect(rowButtons(root, 1)[0]!.disabled).toBe(false);
  });

  it("formats durations and sizes like the server does", () => {
    for (const s of [0, 7, 59.6, 90, 212.4, 3599, 3600, 3725, 36_000]) expect(widgetDuration(s)).toBe(formatDuration(s));
    for (const b of [0, 999, 512_000, 999_999, 1_000_000, 52_400_000, 1_234_567_890]) expect(widgetSize(b)).toBe(formatSize(b));
    for (const kind of ["duration", "size"] as const) {
      for (const value of [0, 212.4, "90", " 90 ", "", " ", "\t", "abc"]) {
        expect(cellText({ key: "x", label: "x", kind }, value)).toBe(tableCellText(kind, value));
      }
    }
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatSize(52_400_000)).toBe("52.4 MB");
  });
});

describe("built table widget", () => {
  const html = readFileSync(new URL("../src/assets/table.html", import.meta.url), "utf8");
  const buttons = (page: Awaited<ReturnType<typeof runPageScript>>, row: number) => rowButtons(page.root, row);

  it("inlines the app bundle and the render logic as globals, and never uses innerHTML", () => {
    expect(html).toContain("globalThis.__mcpApps=");
    expect(html).toContain("globalThis.__widget=");
    expect(html).not.toContain("/*__LOGIC__*/");
    expect(html).not.toContain("innerHTML");
  });

  it("keeps acted rows disabled when the same tool result is replayed, and leaves other rows usable", async () => {
    const page = await runPageScript(html, { renderTable });
    page.fire(data);
    buttons(page, 0)[0]!.click();
    expect(page.sent).toEqual(["Share Mix v3 with the client"]);
    page.fire(data);
    expect(buttons(page, 0).every((b) => b.disabled)).toBe(true);
    buttons(page, 0)[1]!.click();
    expect(page.sent).toHaveLength(1);
    expect(buttons(page, 1)[0]!.disabled).toBe(false);
    buttons(page, 1)[0]!.click();
    expect(page.sent).toEqual(["Share Mix v3 with the client", "Share Mix v2"]);
  });

  it("starts fresh when a different table arrives", async () => {
    const page = await runPageScript(html, { renderTable });
    page.fire(data);
    buttons(page, 0)[0]!.click();
    page.fire({ ...data, title: "Another table" });
    expect(buttons(page, 0).every((b) => !b.disabled)).toBe(true);
  });
});
