import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolContext } from "../../src/mcp/context.js";
import type { Operation } from "../../src/mcp/operations.js";
import type { ConnectorOptions } from "../../src/mcp/options.js";
import { getOperation } from "../../src/mcp/registry.js";
import { HOT_PATH, createMcpServer } from "../../src/mcp/server.js";
import { createSamplyClient } from "../../src/samply/client.js";
import { memoryUsageStore } from "../../src/usage/memory.js";
import type { UsageStore } from "../../src/usage/store.js";

export const BASE = "https://samply.test/api/v0";

type Route = { match: RegExp; method?: string; status?: number; body?: unknown; headers?: Record<string, string> };

/** A Samply that answers by URL pattern (and method) and records every request. */
export function fakeSamply(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const r = routes.find((x) => x.match.test(url) && (!x.method || x.method === method));
    if (!r) return new Response(`unexpected ${method} ${url}`, { status: 500 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  };
  return { fetchImpl, calls };
}

export async function connected(
  fetchImpl: typeof fetch,
  opts?: { usage?: UsageStore; session?: ToolContext["session"]; options?: ConnectorOptions; publicUrl?: string },
) {
  const session: ToolContext["session"] = opts?.session ?? { samplyUnauthorized: false, wrote: false };
  const samply = createSamplyClient({ baseUrl: BASE, accessToken: "tok", fetch: fetchImpl, onWrite: () => { session.wrote = true; } });
  const server = createMcpServer({ samply, anonId: "anon", usage: opts?.usage ?? memoryUsageStore(), session }, opts?.publicUrl, opts?.options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

/** An operation's description and every description in its input schema: all the text a model reads about it. */
export function operationTexts(op: Operation): string[] {
  const texts = [op.description];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string") texts.push(value);
        else walk(value);
      }
    }
  };
  walk(z.toJSONSchema(op.input, { io: "input" }));
  return texts;
}

/** Every operation name in `text`, as a whole word (create_player does not match inside create_player_x). */
export function mentionedOperations(text: string, names: readonly string[]): Array<{ name: string; index: number }> {
  return names.flatMap((name) =>
    [...text.matchAll(new RegExp(`(?<![a-z_])${name}(?![a-z_])`, "g"))].map((m) => ({ name, index: m.index })),
  );
}

export const REAL_TOOLS = new Set<string>([...HOT_PATH, "samply_explore", "samply_read", "samply_write", "ask_user_choice", "show_table"]);

/** Calls `name` directly when it is a real tool, otherwise through samply_read or samply_write. */
export async function callJson(client: Client, name: string, args: Record<string, unknown>) {
  const gateway = getOperation(name)?.kind === "write" ? "samply_write" : "samply_read";
  const result = REAL_TOOLS.has(name)
    ? await client.callTool({ name, arguments: args })
    : await client.callTool({ name: gateway, arguments: { operation: name, args } });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as unknown };
}
