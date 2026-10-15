import { describe, expect, it } from "vitest";
import { SamplyError, createSamplyClient } from "../../src/samply/client.js";

function fake(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return { fetchImpl, calls };
}

describe("samply client", () => {
  it("sends the bearer token, accepts JSON, and parses the answer", async () => {
    const f = fake(() => Response.json([{ id: "p1" }]));
    const c = createSamplyClient({ baseUrl: "https://samply.test/api/v0", accessToken: "tok", fetch: f.fetchImpl });
    expect(await c.get("/projects")).toEqual([{ id: "p1" }]);
    const headers = new Headers(f.calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("accept")).toBe("application/json");
    expect(f.calls[0]!.url).toBe("https://samply.test/api/v0/projects");
  });

  it("appends a query, posts JSON, deletes, and treats an empty body as {}", async () => {
    const f = fake((url, init) => (init?.method === "DELETE" ? new Response("", { status: 200 }) : Response.json({ ok: true })));
    const c = createSamplyClient({ baseUrl: "https://samply.test/api/v0", accessToken: "tok", fetch: f.fetchImpl });
    await c.get("/players", { projectid: "p1", skip: undefined });
    expect(f.calls[0]!.url).toBe("https://samply.test/api/v0/players?projectid=p1");
    await c.post("/players", { name: "x" });
    expect(f.calls[1]!.init?.method).toBe("POST");
    expect(new Headers(f.calls[1]!.init?.headers).get("content-type")).toBe("application/json");
    expect(f.calls[1]!.init?.body).toBe('{"name":"x"}');
    expect(await c.delete("/webhooks/w1")).toEqual({});
  });

  it("fires onWrite after a successful non-GET only", async () => {
    let writes = 0;
    const f = fake((url) => (url.endsWith("/fail") ? new Response("no", { status: 400 }) : Response.json({})));
    const c = createSamplyClient({ baseUrl: "https://samply.test/api/v0", accessToken: "tok", fetch: f.fetchImpl, onWrite: () => writes++ });
    await c.get("/projects");
    expect(writes).toBe(0);
    await expect(c.post("/fail", {})).rejects.toThrow(SamplyError);
    expect(writes).toBe(0);
    await c.post("/players", {});
    expect(writes).toBe(1);
  });

  it("retries once on 429 and surfaces other errors with status and a short body", async () => {
    let n = 0;
    const f = fake(() => (n++ === 0 ? new Response("slow down", { status: 429 }) : Response.json({ ok: 1 })));
    const c = createSamplyClient({ baseUrl: "https://samply.test/api/v0", accessToken: "tok", fetch: f.fetchImpl });
    expect(await c.get("/projects")).toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(2);

    const g = fake(() => new Response("x".repeat(2000), { status: 500 }));
    const d = createSamplyClient({ baseUrl: "https://samply.test/api/v0", accessToken: "tok", fetch: g.fetchImpl });
    const err = await d.get("/projects").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SamplyError);
    expect((err as SamplyError).status).toBe(500);
    expect((err as SamplyError).body).toHaveLength(500);
  }, 10_000);

  it("refuses a non-JSON 200", async () => {
    const f = fake(() => new Response("<html>", { status: 200 }));
    const c = createSamplyClient({ baseUrl: "https://samply.test/api/v0", accessToken: "tok", fetch: f.fetchImpl });
    await expect(c.get("/projects")).rejects.toMatchObject({ status: 502 });
  });
});
