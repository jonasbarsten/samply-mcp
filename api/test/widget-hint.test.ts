import { describe, expect, it } from "vitest";
import { renderChoice } from "../src/widget/choice.mjs";
import { renderTable } from "../src/widget/table.mjs";
import { FakeEl } from "./fake-dom.js";

// ChatGPT sends a widget's message at once; Claude puts it in the composer for the user to send. True in both:
const HINT = "Your answer was sent to the chat. If it sits in the message box, press send.";
const doc = { createElement: (tag: string) => new FakeEl(tag) };
const hints = (root: FakeEl) => root.all().filter((e) => e.className === "hint");
const noop = () => {};

describe("after an answer, every widget says where the message went", () => {
  it("choice: an option, and «Use» on the Other field", () => {
    const root = new FakeEl("div");
    renderChoice(doc as never, root as never, { question: "Which project?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], allowOther: true }, noop);
    expect(hints(root)).toEqual([]);
    expect(root.all().find((e) => e.tag === "button" && e.textContent === "Use")).toBeDefined();
    root.all().find((e) => e.className === "option")!.click();
    expect(hints(root).map((e) => e.textContent)).toEqual([HINT]);
  });

  it("table: one hint, however many rows are acted on", () => {
    const root = new FakeEl("div");
    const rows = [1, 2].map((n) => ({ cells: { nr: String(n) }, actions: [{ label: "Show", message: `Show ${n}` }] }));
    renderTable(doc as never, root as never, { title: "T", columns: [{ key: "nr", label: "Nr" }], rows }, noop);
    for (const b of root.all().filter((e) => e.tag === "button" && e.textContent === "Show")) b.click();
    expect(hints(root).map((e) => e.textContent)).toEqual([HINT]);
  });
});
