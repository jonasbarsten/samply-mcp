import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "./context.js";
import { registerGateway } from "./gateway.js";
import { type Operation, registerOperationTool } from "./operations.js";
import { type ConnectorOptions, visibleOperations } from "./options.js";
import { registerChoiceTool } from "./tools/choice.js";
import { registerTableTool } from "./tools/table.js";

/** Operations that stay real tools: the everyday flows (what is in a project, share it, what did the client say) without an explore round trip. */
export const HOT_PATH = ["list_projects", "list_items", "list_players", "list_comments", "create_player"] as const;

const HOT = new Set<string>(HOT_PATH);

export const SERVER_INSTRUCTIONS =
  "Samply holds the user's audio projects: files, folders and stacks (versions) in a project, players (the app calls them Links) that share files with others, and timestamped comments. " +
  "Ids are strings; get them from the list operations before using them. When the user must choose between options (which project, which file, which player), call ask_user_choice instead of asking in text; show lists of items with show_table. " +
  "Before any write, restate what will change and wait for the user's answer. Making a player public shares the audio with anyone who has the link; say so.";

/** Registers the visible hot-path operations as real tools and the gateway over everything visible. */
function registerAllTools(server: McpServer, ctx: ToolContext, visible: readonly Operation[]): void {
  for (const op of visible) if (HOT.has(op.name)) registerOperationTool(server, ctx, op);
  registerGateway(server, ctx, visible);
}

/** `publicUrl` makes serverInfo advertise the connector icon at `<publicUrl>/icon.png`. */
export function createMcpServer(ctx: ToolContext, publicUrl?: string, options: ConnectorOptions = { readOnly: false }): McpServer {
  const server = new McpServer(
    {
      name: "samply-mcp",
      version: "0.1.0",
      ...(publicUrl ? { icons: [{ src: `${publicUrl}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }] } : {}),
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, ctx, visibleOperations(options));
  // Write nothing, so they are on every connection, read-only and concept-filtered ones included.
  registerChoiceTool(server, ctx);
  registerTableTool(server, ctx);
  return server;
}
