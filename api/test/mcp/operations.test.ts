import { describe, expect, it } from "vitest";
import { uploadCurl } from "../../src/mcp/tools/files.js";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { BASE, callJson, connected, fakeSamply } from "./helpers.js";

const T = 1_700_000_000_000;
const ISO = "2023-11-14T22:13:20.000Z";

describe("projects", () => {
  it("lists projects trimmed, with ISO times, filtered by name", async () => {
    const f = fakeSamply([{ match: /\/projects$/, body: [
      { id: "p1", object: "project", name: "Album", size: 10, color: "#fff", artwork: "x", creator: { id: "u" }, timeCreated: T, timeModified: T },
      { id: "p2", object: "project", name: "Demos", size: 0, timeCreated: T, timeModified: T },
    ] }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_projects", {})).json()).toEqual([
      { id: "p1", name: "Album", size: 10, color: "#fff", timeCreated: ISO, timeModified: ISO },
      { id: "p2", name: "Demos", size: 0, timeCreated: ISO, timeModified: ISO },
    ]);
    expect((await callJson(c, "list_projects", { nameContains: "dem" })).json()).toEqual([{ id: "p2", name: "Demos", size: 0, timeCreated: ISO, timeModified: ISO }]);
    expect(f.calls.every((x) => x.url === `${BASE}/projects` && x.method === "GET")).toBe(true);
  });

  it("gets, creates and updates a project with POST, sending only given fields, and refuses an empty update", async () => {
    const f = fakeSamply([
      { match: /\/projects\/p1$/, method: "GET", body: { id: "p1", name: "Album", timeCreated: T } },
      { match: /\/projects$/, method: "POST", body: { id: "p3", name: "New", playerUrl: "https://samply.test/p/abc" } },
      { match: /\/projects\/p1$/, method: "POST", body: { id: "p1", name: "Renamed" } },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "get_project", { projectId: "p1" })).json()).toEqual({ id: "p1", name: "Album", timeCreated: ISO });
    const created = await callJson(c, "create_project", { name: "New", collaborators: [{ email: "a@b.co", role: "viewer" }] });
    expect(created.json()).toMatchObject({ id: "p3", playerUrl: "https://samply.test/p/abc" });
    expect(f.calls[1]).toMatchObject({ method: "POST", body: { name: "New", collaborators: [{ email: "a@b.co", role: "viewer" }] } });
    expect(f.calls[1]!.body).not.toHaveProperty("upload");
    const updated = await callJson(c, "update_project", { projectId: "p1", name: "Renamed" });
    expect(updated.json()).toEqual({ id: "p1", name: "Renamed" });
    expect(f.calls[2]).toMatchObject({ url: `${BASE}/projects/p1`, method: "POST", body: { name: "Renamed" } });
    const empty = await callJson(c, "update_project", { projectId: "p1" });
    expect(empty.isError).toBe(true);
    expect(f.calls).toHaveLength(3);
  });

  it("refuses an unknown key and a bad role before any call", async () => {
    const f = fakeSamply([]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "create_project", { name: "x", colour: "red" })).isError).toBe(true);
    expect((await callJson(c, "create_project", { name: "x", collaborators: [{ email: "a@b.co", role: "owner" }] })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("names the id sources on a 404", async () => {
    const c = await connected(fakeSamply([{ match: /\/projects\/nope$/, status: 404, body: "not found" }]).fetchImpl);
    const r = await callJson(c, "get_project", { projectId: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("404");
    expect(r.text).toContain("list_projects");
  });
});

describe("files", () => {
  const boxes = [
    { id: "f1", object: "file", name: "Mix v1.wav", duration: 200, timeCreated: T },
    { id: "s1", object: "stack", name: "Mix", children: [{ id: "f1" }, { id: "f2" }], timeCreated: T },
    { id: "d1", object: "folder", name: "Stems", timeCreated: T },
    { id: "f2", object: "file", name: "Mix v2.wav", duration: 201, timeCreated: T },
  ];

  it("lists a project's boxes with filters and a limit, and gets one", async () => {
    const f = fakeSamply([
      { match: /\/projects\/p1\/all$/, body: boxes },
      { match: /\/projects\/p1\/files\/s1$/, body: boxes[1] },
    ]);
    const c = await connected(f.fetchImpl);
    const all = (await callJson(c, "list_items", { projectId: "p1" })).json() as { items: Array<{ id: string; timeCreated?: string }>; total: number };
    expect(all.total).toBe(4);
    expect(all.items.map((i) => i.id)).toEqual(["f1", "s1", "d1", "f2"]);
    expect(all.items[0]?.timeCreated).toBe(ISO);
    const files = (await callJson(c, "list_items", { projectId: "p1", kind: "file", nameContains: "v2" })).json() as { items: Array<{ id: string }>; total: number };
    expect(files).toMatchObject({ total: 1 });
    expect(files.items.map((i) => i.id)).toEqual(["f2"]);
    const limited = (await callJson(c, "list_items", { projectId: "p1", limit: 2 })).json() as { items: unknown[]; total: number };
    expect(limited.items).toHaveLength(2);
    expect(limited.total).toBe(4);
    expect((await callJson(c, "get_item", { projectId: "p1", itemId: "s1" })).json()).toMatchObject({ id: "s1", object: "stack" });
  });

  it("gets a download url, creates folders and stacks, and updates items with Samply's field names", async () => {
    const f = fakeSamply([
      { match: /\/files\/f1\/download$/, body: { url: "https://cdn.test/f1", expires: 123 } },
      { match: /\/projects\/p1\/folders$/, method: "POST", body: { id: "d2", object: "folder", name: "Masters" } },
      { match: /\/projects\/p1\/stacks$/, method: "POST", body: { id: "s2", object: "stack", name: "Mix" } },
      { match: /\/projects\/p1\/files\/d2$/, method: "POST", body: { id: "d2", object: "folder", name: "Masters" } },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "get_download_url", { projectId: "p1", fileId: "f1" })).json()).toEqual({ url: "https://cdn.test/f1", expires: 123 });
    expect((await callJson(c, "create_folder", { projectId: "p1", name: "Masters", color: "#112233" })).json()).toMatchObject({ id: "d2" });
    expect(f.calls[1]!.body).toEqual({ name: "Masters", color: "#112233" });
    expect((await callJson(c, "create_stack", { projectId: "p1", name: "Mix", childIds: ["f1", "f2"] })).json()).toMatchObject({ id: "s2" });
    expect(f.calls[2]!.body).toEqual({ name: "Mix", childids: ["f1", "f2"] });
    const moved = await callJson(c, "update_item", { projectId: "p1", itemId: "d2", addIds: ["f1"], removeIds: ["f2"], trashed: false });
    expect(moved.isError).toBe(false);
    expect(f.calls[3]!.body).toEqual({ addids: ["f1"], removeids: ["f2"], trashed: false });
    expect((await callJson(c, "update_item", { projectId: "p1", itemId: "d2" })).isError).toBe(true);
    expect((await callJson(c, "create_folder", { projectId: "p1", name: "x", color: "red" })).isError).toBe(true);
    expect(f.calls).toHaveLength(4);
  });

  it("requests an upload slot and returns a curl with the slot's headers, the bytes never touching this server", async () => {
    const slot = { boxid: "f9", stackid: "s9", url: "https://storage.test/put?sig=a'b", headers: { "Content-Type": "audio/wav", "x-goog-meta-x": "1" }, metadata: { projectid: "p1" } };
    const f = fakeSamply([{ match: /\/projects\/p1\/files$/, method: "POST", body: slot }]);
    const c = await connected(f.fetchImpl);
    const r = (await callJson(c, "request_upload", { projectId: "p1", name: "Mix v3.wav", mimeType: "audio/wav", size: 1234, parentId: "s9", localPath: "./mix.wav" })).json() as Record<string, unknown>;
    expect(f.calls[0]!.body).toEqual({ name: "Mix v3.wav", mimeType: "audio/wav", size: 1234, parentid: "s9" });
    expect(r).toMatchObject({ boxid: "f9", stackid: "s9", url: slot.url });
    expect(r.curl).toBe(`curl --fail -X PUT -H 'Content-Type: audio/wav' -H 'x-goog-meta-x: 1' --upload-file './mix.wav' 'https://storage.test/put?sig=a'\\''b'`);
    expect(String(r.note)).toContain("list_items (via samply_read)");
  });

  it("builds the curl with a Content-Type when Samply names no headers, and none without a url", () => {
    expect(uploadCurl({ url: "https://s.test/u" }, "audio/mpeg")).toBe("curl --fail -X PUT -H 'Content-Type: audio/mpeg' --upload-file '<path to the file>' 'https://s.test/u'");
    expect(uploadCurl({ url: "https://s.test/u", headers: { "content-type": "audio/wav", skip: 1 } }, "audio/mpeg")).toBe("curl --fail -X PUT -H 'content-type: audio/wav' --upload-file '<path to the file>' 'https://s.test/u'");
    expect(uploadCurl({}, "audio/mpeg")).toBeUndefined();
  });
});

describe("players", () => {
  const players = [
    { id: "pl1", object: "player", name: "Album link", projectid: "p1", public: true, timeCreated: T },
    { id: "pl2", object: "player", name: "Client mix", projectid: "p2", public: false, timeCreated: T },
  ];

  it("lists players with filters, gets one, creates and updates with Samply's field names", async () => {
    const f = fakeSamply([
      { match: /\/players$/, method: "GET", body: players },
      { match: /\/players\/pl2$/, method: "GET", body: players[1] },
      { match: /\/players$/, method: "POST", body: { id: "pl3", name: "Mix v3", public: true } },
      { match: /\/players\/pl3$/, method: "POST", body: { id: "pl3", name: "Mix v3", public: false } },
    ]);
    const c = await connected(f.fetchImpl);
    expect(((await callJson(c, "list_players", {})).json() as unknown[]).length).toBe(2);
    expect(((await callJson(c, "list_players", { projectId: "p2" })).json() as Array<{ id: string }>).map((p) => p.id)).toEqual(["pl2"]);
    expect(((await callJson(c, "list_players", { nameContains: "album" })).json() as Array<{ id: string }>).map((p) => p.id)).toEqual(["pl1"]);
    expect((await callJson(c, "get_player", { playerId: "pl2" })).json()).toMatchObject({ id: "pl2", timeCreated: ISO });
    const created = await callJson(c, "create_player", { name: "Mix v3", projectId: "p1", boxIds: ["s1"], public: true, options: { quality: "lossless", downloads: false, custom: "x" } });
    expect(created.json()).toMatchObject({ id: "pl3" });
    expect(f.calls.at(-1)!.body).toEqual({ name: "Mix v3", projectid: "p1", boxids: ["s1"], public: true, options: { quality: "lossless", downloads: false, custom: "x" } });
    const updated = await callJson(c, "update_player", { playerId: "pl3", public: false });
    expect(updated.json()).toMatchObject({ public: false });
    expect(f.calls.at(-1)).toMatchObject({ url: `${BASE}/players/pl3`, method: "POST", body: { public: false } });
  });

  it("refuses folderId together with boxIds, an empty update and a bad quality, before any call", async () => {
    const f = fakeSamply([]);
    const c = await connected(f.fetchImpl);
    const both = await callJson(c, "create_player", { name: "x", projectId: "p1", folderId: "d1", boxIds: ["f1"] });
    expect(both).toMatchObject({ isError: true, text: "Give folderId or boxIds, not both." });
    expect((await callJson(c, "update_player", { playerId: "pl1" })).isError).toBe(true);
    expect((await callJson(c, "create_player", { name: "x", projectId: "p1", options: { quality: "best" } })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("warns that a public player shares the audio", async () => {
    const c = await connected(fakeSamply([]).fetchImpl);
    const tool = (await c.listTools()).tools.find((t) => t.name === "create_player");
    expect(tool?.description).toContain("anyone with the link can listen");
    expect(tool?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });
});

describe("comments", () => {
  it("lists and creates comments on a file, mapping parentId", async () => {
    const f = fakeSamply([
      { match: /\/projects\/p1\/files\/f1\/comments$/, method: "GET", body: [{ id: "c1", object: "comment", message: "Louder", audioTimestamp: 12.5, creator: { name: "A" }, timeCreated: T }] },
      { match: /\/projects\/p1\/files\/f1\/comments$/, method: "POST", body: { id: "c2", object: "comment", message: "Done", parentid: "c1" } },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_comments", { projectId: "p1", fileId: "f1" })).json()).toEqual([{ id: "c1", object: "comment", message: "Louder", audioTimestamp: 12.5, creator: { name: "A" }, timeCreated: ISO }]);
    const created = await callJson(c, "create_comment", { projectId: "p1", fileId: "f1", message: "Done", parentId: "c1", audioTimestamp: 12.5, audioTimestampEnd: 14 });
    expect(created.json()).toMatchObject({ id: "c2" });
    expect(f.calls[1]!.body).toEqual({ message: "Done", parentid: "c1", audioTimestamp: 12.5, audioTimestampEnd: 14 });
  });
});

describe("webhooks", () => {
  it("creates with the documented events and deletes by id", async () => {
    const f = fakeSamply([
      { match: /\/webhooks$/, method: "POST", body: { id: "w1", label: "CI", url: "https://h.test/x", events: ["upload.completed"], secret: "whsec_abc", timeCreated: T } },
      { match: /\/webhooks\/w1$/, method: "DELETE", body: {} },
    ]);
    const c = await connected(f.fetchImpl);
    const created = await callJson(c, "create_webhook", { label: "CI", url: "https://h.test/x", events: ["upload.completed"] });
    expect(created.json()).toMatchObject({ id: "w1", secret: "whsec_abc", timeCreated: ISO });
    expect(f.calls[0]!.body).toEqual({ label: "CI", url: "https://h.test/x", events: ["upload.completed"] });
    expect((await callJson(c, "delete_webhook", { webhookId: "w1" })).json()).toEqual({ deleted: "w1" });
    expect(f.calls[1]).toMatchObject({ method: "DELETE", url: `${BASE}/webhooks/w1` });
    expect((await callJson(c, "create_webhook", { label: "x", url: "http://h.test/x", events: ["upload.completed"] })).isError).toBe(true);
    expect((await callJson(c, "create_webhook", { label: "x", url: "https://h.test/x", events: ["file.uploaded"] })).isError).toBe(true);
    expect(f.calls).toHaveLength(2);
  });
});

describe("usage", () => {
  it("my_usage returns the caller's own months", async () => {
    const usage = memoryUsageStore();
    const c = await connected(fakeSamply([{ match: /\/players$/, body: [] }]).fetchImpl, { usage });
    await callJson(c, "list_players", {});
    const r = (await callJson(c, "my_usage", {})).json() as { anonId: string; months: Array<{ tools: Record<string, number> }> };
    expect(r.anonId).toBe("anon");
    expect(r.months[0]?.tools).toEqual({ list_players: 1 });
  });
});

describe("errors", () => {
  it("never shows the bearer token, and explains a refused login", async () => {
    const c = await connected(fakeSamply([{ match: /./, status: 401, body: "expired tok" }]).fetchImpl);
    const r = await callJson(c, "list_players", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Samply rejected the login (401)");
    expect(r.text).not.toContain("Bearer");
  });
});
