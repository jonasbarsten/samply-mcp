import type { Operation } from "./operations.js";
import { commentsOperations } from "./tools/comments.js";
import { filesOperations } from "./tools/files.js";
import { playersOperations } from "./tools/players.js";
import { projectsOperations } from "./tools/projects.js";
import { usageOperations } from "./tools/usage.js";
import { webhooksOperations } from "./tools/webhooks.js";

/** Every operation, by concept, in the order samply_explore lists them. */
export const OPERATIONS: readonly Operation[] = [
  ...projectsOperations,
  ...filesOperations,
  ...playersOperations,
  ...commentsOperations,
  ...webhooksOperations,
  ...usageOperations,
];

const BY_NAME = new Map(OPERATIONS.map((op) => [op.name, op]));

/** Any operation by name; the gateway uses its own map of visible operations, so this lookup serves the registry and tests. */
export function getOperation(name: string): Operation | undefined {
  return BY_NAME.get(name);
}
