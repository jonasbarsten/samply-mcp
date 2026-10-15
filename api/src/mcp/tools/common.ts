import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorText, noteSamplyError, toolError, type ToolContext } from "../context.js";

export const projectId = z.string().min(1).describe("Project id, from list_projects");
export const itemId = z.string().min(1).describe("Id of a file, folder or stack (a box), from list_items");
export const playerId = z.string().min(1).describe("Player id, from list_players");

export const CONFIRM = "Consequential: before calling, restate the exact action with every value to the user and get explicit confirmation.";

/** The exact gateway call a recovery text asks for, e.g. `call samply_read with {"operation":"get_project","args":{...}}`. */
export function gatewayCall(gateway: "samply_read" | "samply_write", operation: string, args: Record<string, unknown>): string {
  return `call ${gateway} with ${JSON.stringify({ operation, args })}`;
}

/** A tool error result carrying `text`. */
export function toolText(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Drops keys whose value is undefined so Samply only sees what the caller gave. */
export function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/**
 * Runs a Samply call and turns its failure into a tool error, after noting whether a refusal means
 * the login itself is dead. Every operation's `run` goes through here.
 */
export async function attempt(ctx: ToolContext, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(err, await noteSamplyError(ctx, err));
  }
}

/**
 * The write (`what` was `did`, e.g. "Player 5" was "created") succeeded but the answer could not be
 * read: says not to repeat it and names the read that shows it.
 */
export function readBackFailed(what: string, did: string, err: unknown, operation: string, args: Record<string, unknown>): CallToolResult {
  return toolText(`${what} was ${did}; reading it back failed: ${errorText(err)}. Do not repeat it; ${gatewayCall("samply_read", operation, args)}.`);
}

/** Samply answers with a JSON object; anything else is returned as it came so the model can see it. */
export type SamplyObject = Record<string, unknown>;

/** Milliseconds since the epoch, as Samply sends times, to an ISO string; anything else is passed through. */
export function isoTime(value: unknown): unknown {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : value;
}

/** Copies an object with its `timeCreated` and `timeModified` as ISO strings, so the model need not convert epoch millis. */
export function withIsoTimes<T extends SamplyObject>(obj: T): T {
  const out: SamplyObject = { ...obj };
  for (const key of ["timeCreated", "timeModified"]) if (key in out) out[key] = isoTime(out[key]);
  return out as T;
}
