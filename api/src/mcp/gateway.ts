import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { counted, type ToolContext } from "./context.js";
import { CONCEPTS, type Concept, type Operation } from "./operations.js";
import { CONFIRM, toolText } from "./tools/common.js";

const direct = (gateways: string) =>
  `An operation named in an earlier result (for example "use get_player") can be passed to ${gateways} without exploring first; only the tools in your tool list can be called by name.`;
const USAGE_READ_WRITE = `Pass an operation name and its args to samply_read (reads) or samply_write (writes). ${direct("samply_read or samply_write")}`;
const USAGE_READ_ONLY = `Pass an operation name and its args to samply_read. ${direct("samply_read")}`;
const ARGS_HINT = 'Put the operation\'s inputs under args, for example {"operation":"get_project","args":{"projectId":"..."}}.';

/** `args` as an object: missing is empty, a JSON string is parsed; undefined when it is neither an object nor a JSON object. */
export function argsObject(args: unknown): Record<string, unknown> | undefined {
  let value: unknown = args ?? {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The JSON Schema of what a caller passes: `io: "input"` keeps defaulted fields optional, and the
 * root refuses extra keys because the gateway parses it strictly.
 */
function inputSchema(op: Operation) {
  const { $schema: _, ...schema } = z.toJSONSchema(op.input.strict(), { io: "input" });
  return schema;
}

/** Compact JSON: explore results carry many schemas, so indentation would only cost context. */
function compactJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function describeOperation(op: Operation) {
  return { name: op.name, kind: op.kind, destructive: op.destructive, title: op.title, description: op.description, input: inputSchema(op) };
}

/**
 * Registers `samply_explore`, `samply_read` and, when anything visible writes, `samply_write`.
 * `visible` is what the gateway may show and run; anything else is an unknown operation.
 */
export function registerGateway(server: McpServer, ctx: ToolContext, visible: readonly Operation[]): void {
  const byName = new Map(visible.map((op) => [op.name, op]));
  const concepts = (Object.keys(CONCEPTS) as Concept[]).filter((c) => visible.some((op) => op.concept === c));
  const writes = visible.some((op) => op.kind === "write");

  server.registerTool(
    "samply_explore",
    {
      title: "Explore Samply operations",
      description:
        "Find what this connector can do in Samply beyond the tools listed directly: call with no path for the list of concepts (projects, files, players, ...), then with a concept to get its operations and their exact inputs.",
      inputSchema: z.object({
        path: z.string().optional().describe("Empty for the list of concepts; a concept such as players for its operations; an operation name for just that one"),
      }),
      annotations: { readOnlyHint: true },
    },
    counted(ctx, "samply_explore", async ({ path }: { path?: string }) => {
      if (!path) {
        return compactJson({
          concepts: concepts.map((name) => ({
            name,
            summary: CONCEPTS[name],
            operations: visible.filter((op) => op.concept === name).map((op) => op.name),
          })),
          usage: writes ? USAGE_READ_WRITE : USAGE_READ_ONLY,
        });
      }
      if ((concepts as string[]).includes(path)) {
        const concept = path as Concept;
        return compactJson({
          concept,
          summary: CONCEPTS[concept],
          operations: visible.filter((op) => op.concept === concept).map(describeOperation),
        });
      }
      const op = byName.get(path);
      if (op) return compactJson(describeOperation(op));
      return toolText(`Unknown path "${path}". Concepts: ${concepts.join(", ")}.`);
    }),
  );

  // Advertised as strict with an object args, but accepted loosely so the handler can answer a key
  // outside args, or args sent as a JSON string, with its own hint instead of the SDK's validation error.
  const runInput = z
    .object({
      operation: z.string().min(1),
      args: z.unknown().optional().meta({ type: "object", description: "The operation's inputs, as samply_explore shows them" }),
    })
    .loose()
    .meta({ additionalProperties: false });

  const registerRunner = (gateway: "samply_read" | "samply_write", kind: Operation["kind"], title: string, description: string) => {
    const other = kind === "read" ? "samply_write" : "samply_read";
    server.registerTool(
      gateway,
      {
        title,
        description,
        inputSchema: runInput,
        annotations: kind === "read" ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true },
      },
      async ({ operation, args: rawArgs, ...stray }: z.output<typeof runInput>, extra: unknown) => {
        const refuse = (text: string) => counted(ctx, gateway, async () => toolText(text))(undefined, extra);
        const args = argsObject(rawArgs);
        if (!args || Object.keys(stray).length > 0) return refuse(ARGS_HINT);
        const op = byName.get(operation);
        if (!op) return refuse(`Unknown operation "${operation}". Call samply_explore to see what exists.`);
        if (op.kind !== kind) return refuse(`${op.name} is a ${op.kind} operation; call it with ${other}.`);
        const parsed = op.input.strict().safeParse(args);
        if (!parsed.success) {
          return refuse(
            `Invalid arguments for ${op.name}: ${z.prettifyError(parsed.error)}\nExpected input: ${JSON.stringify(inputSchema(op))}`,
          );
        }
        return counted(ctx, op.name, () => op.run(ctx, parsed.data))(undefined, extra);
      },
    );
  };

  registerRunner("samply_read", "read", "Run a Samply read", "Run a read operation found with samply_explore, with its args. Reads never change anything in Samply.");
  if (!writes) return;
  registerRunner(
    "samply_write",
    "write",
    "Run a Samply write",
    "Run a write operation found with samply_explore, with its args. Writes change the user's Samply account; some are visible to others at once (a public player, a comment collaborators see). " +
      CONFIRM,
  );
}
