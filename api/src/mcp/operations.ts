import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { counted, type ToolContext } from "./context.js";

export const CONCEPTS = {
  projects: "Projects: the containers for audio files, with their upload portal and collaborators",
  files: "Files, folders and stacks (versions) inside a project: browse, download, upload, organise",
  players: "Players, called Links in the app: shareable pages that play files from a project",
  comments: "Timestamped comments on a file",
  webhooks: "Webhooks that notify a URL of uploads, comments, players and projects",
  usage: "Your own usage counters on this server",
} as const;
export type Concept = keyof typeof CONCEPTS;

export interface Operation<S extends z.ZodObject = z.ZodObject> {
  name: string;
  concept: Concept;
  kind: "read" | "write";
  /** False for reads and for writes that are easy to undo in Samply (a new folder, an upload slot). */
  destructive: boolean;
  title: string;
  description: string;
  input: S;
  run(ctx: ToolContext, args: z.output<S>): Promise<CallToolResult>;
}

/**
 * Types `run` from the operation's own schema. The result widens to `Operation`
 * without a cast because `run` is declared with method syntax, whose parameters
 * TypeScript checks bivariantly.
 */
export function defineOperation<S extends z.ZodObject>(op: Operation<S>): Operation {
  return op;
}

/**
 * Registers an operation as a real MCP tool, counted under its own name. The input is strict, as
 * through the gateway, so a mistyped key is refused instead of silently dropped.
 */
export function registerOperationTool(server: McpServer, ctx: ToolContext, op: Operation): void {
  server.registerTool(
    op.name,
    {
      title: op.title,
      description: op.description,
      inputSchema: op.input.strict(),
      annotations: op.kind === "read" ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: op.destructive },
    },
    counted(ctx, op.name, (args) => op.run(ctx, args as never)),
  );
}
