import type { CallToolResult } from "@modelcontextprotocol/server";
import { log } from "../log.js";
import { SamplyError, type SamplyClient } from "../samply/client.js";
import { LOGIN_CHECK_PATH } from "../samply/login.js";
import type { UsageStore } from "../usage/store.js";

export interface ToolContext {
  samply: SamplyClient;
  anonId: string;
  usage: UsageStore;
  /**
   * Per-request state. `samplyUnauthorized` is set when Samply refused the token on a path where
   * nothing was written and `GET /projects` confirms the token is dead, so `/mcp` can answer HTTP
   * 401. `loginChecked` caches that check's outcome, so a request makes it at most once.
   */
  session: { samplyUnauthorized: boolean; wrote: boolean; loginChecked?: LoginState };
}

/**
 * What is known about the login when Samply answered 401 or 403: `GET /projects` confirmed the token
 * dead ("invalid") or working ("valid"), or it was not checked or the check failed another way ("unknown").
 */
export type LoginState = "valid" | "invalid" | "unknown";

export function toolJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const isAuthFailure = (err: unknown): boolean => err instanceof SamplyError && (err.status === 401 || err.status === 403);

export function errorText(err: unknown, login: LoginState = "unknown"): string {
  if (err instanceof SamplyError) {
    if (isAuthFailure(err)) {
      if (login === "invalid") {
        return `Samply rejected the login (${err.status}). The personal access token no longer works; ask the user to disconnect and reconnect the Samply connector with a token from samply.app/preferences/api, then retry.`;
      }
      if (login === "valid") {
        return `Samply refused this request (${err.status}) although the login is valid: ${err.body}. The token's owner may lack access to this project or item, or the API may not be enabled on their plan (Samply's API is available on team plans and on request).`;
      }
      return `Samply answered ${err.status}: ${err.body}. Retry; if it keeps happening, the user may need to reconnect the Samply connector.`;
    }
    if (err.status === 404) return `Samply responded 404: ${err.body}. Check the id; projects come from list_projects, items from list_items, players from list_players.`;
    return `Samply responded ${err.status}: ${err.body}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

export function toolError(err: unknown, login?: LoginState): CallToolResult {
  return { content: [{ type: "text", text: errorText(err, login) }], isError: true };
}

/**
 * On a Samply 401 or 403 where nothing was written yet, checks the login once per request with
 * `GET /projects`: only a refusal there marks the session dead (so `/mcp` answers HTTP 401 and the
 * client re-sends the same tools/call after refreshing). A refusal on one endpoint with a working
 * login, or a check that fails another way, stays a tool error. Resolves to what is known about the
 * login, for `toolError`; "unknown" when no check was made.
 */
export async function noteSamplyError(ctx: ToolContext, err: unknown): Promise<LoginState> {
  // After a write, a refusal must stay a tool error because the client would re-send the call.
  if (!isAuthFailure(err) || ctx.session.wrote) return "unknown";
  if (ctx.session.loginChecked === undefined) {
    try {
      await ctx.samply.get(LOGIN_CHECK_PATH);
      ctx.session.loginChecked = "valid";
    } catch (checkErr) {
      ctx.session.loginChecked = isAuthFailure(checkErr) ? "invalid" : "unknown";
    }
  }
  if (ctx.session.loginChecked === "invalid") ctx.session.samplyUnauthorized = true;
  return ctx.session.loginChecked;
}

/**
 * Wraps a tool handler so every call is counted after it runs: a thrown error
 * becomes `toolError(err)`, then the outcome is recorded against the caller's
 * anonymous id. A usage-store failure is logged and never changes the result
 * or fails the tool.
 */
export function counted<A>(
  ctx: ToolContext,
  name: string,
  handler: (args: A, extra: unknown) => Promise<CallToolResult>,
): (args: A, extra: unknown) => Promise<CallToolResult> {
  return async (args, extra) => {
    let result: CallToolResult;
    try {
      result = await handler(args, extra);
    } catch (err) {
      result = toolError(err, await noteSamplyError(ctx, err));
    }
    try {
      await ctx.usage.recordCall(ctx.anonId, name, result.isError !== true);
    } catch {
      log("usage_failed", { tool: name });
    }
    return result;
  };
}
