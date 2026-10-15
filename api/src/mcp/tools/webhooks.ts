import { z } from "zod";
import { toolJson } from "../context.js";
import { defineOperation, type Operation } from "../operations.js";
import { CONFIRM, attempt, type SamplyObject, withIsoTimes } from "./common.js";

/** The events Samply documents; the list is sent as given, so a new event Samply adds can be subscribed to only after a code change here. */
export const WEBHOOK_EVENTS = [
  "player.created",
  "player.updated",
  "project.created",
  "project.updated",
  "comment.created",
  "upload.started",
  "upload.completed",
  "upload.failed",
] as const;

export const webhooksOperations: Operation[] = [
  defineOperation({
    name: "create_webhook",
    concept: "webhooks",
    kind: "write",
    destructive: false,
    title: "Create a webhook",
    description:
      "Subscribe a public https URL (port 443 or 8443) to events in the user's account. The answer carries the signing secret (whsec_…) once; the user must copy it from this conversation or read it later in Samply's preferences. " +
      "Deliveries are Standard Webhooks: webhook-id, webhook-timestamp and webhook-signature headers over the raw body.",
    input: z.object({
      label: z.string().min(1).max(100),
      url: z.string().url().refine((u) => u.startsWith("https://"), "must be an https URL"),
      events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).describe("Which events to deliver"),
    }),
    async run(ctx, fields) {
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>("/webhooks", fields))));
    },
  }),

  defineOperation({
    name: "delete_webhook",
    concept: "webhooks",
    kind: "write",
    destructive: true,
    title: "Delete a webhook",
    description: `Stop a webhook for good. Samply's API lists no webhooks, so the id comes from create_webhook (via samply_write) or from Samply's preferences. ${CONFIRM}`,
    input: z.object({ webhookId: z.string().min(1) }),
    async run(ctx, { webhookId }) {
      return attempt(ctx, async () => {
        await ctx.samply.delete(`/webhooks/${encodeURIComponent(webhookId)}`);
        return toolJson({ deleted: webhookId });
      });
    },
  }),
];
