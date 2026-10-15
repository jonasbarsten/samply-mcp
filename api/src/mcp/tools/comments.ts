import { z } from "zod";
import { toolJson } from "../context.js";
import { defineOperation, type Operation } from "../operations.js";
import { CONFIRM, attempt, defined, projectId, type SamplyObject, withIsoTimes } from "./common.js";

const fileId = z.string().min(1).describe("File id (a version), from list_items or a stack's children; a stack id has no comments");
const path = (pid: string, fid: string) => `/projects/${encodeURIComponent(pid)}/files/${encodeURIComponent(fid)}/comments`;

export const commentsOperations: Operation[] = [
  defineOperation({
    name: "list_comments",
    concept: "comments",
    kind: "read",
    destructive: false,
    title: "List comments on a file",
    description:
      "Every comment on one file (a version inside a stack, not the stack itself): message (Markdown), creator, audioTimestamp and audioTimestampEnd in seconds, completed, pinned, replies (isReply with parentid). " +
      "To summarise feedback on a mix, read the comments of its newest version.",
    input: z.object({ projectId, fileId }),
    async run(ctx, { projectId: pid, fileId: fid }) {
      return attempt(ctx, async () => toolJson((await ctx.samply.get<SamplyObject[]>(path(pid, fid))).map(withIsoTimes)));
    },
  }),

  defineOperation({
    name: "create_comment",
    concept: "comments",
    kind: "write",
    destructive: true,
    title: "Comment on a file",
    description:
      "Post a comment on a file, at a point (audioTimestamp, seconds) or over a range (with audioTimestampEnd), or as a reply (parentId). The message is Markdown. " +
      `Everyone with access to the file sees it at once and it is posted in the user's name. ${CONFIRM}`,
    input: z.object({
      projectId,
      fileId,
      message: z.string().min(1).max(5000),
      audioTimestamp: z.number().min(0).optional().describe("Start of the comment, in seconds into the file"),
      audioTimestampEnd: z.number().min(0).optional().describe("End of the range, in seconds; needs audioTimestamp"),
      parentId: z.string().min(1).optional().describe("The comment this replies to"),
      pinned: z.boolean().optional(),
      completed: z.boolean().optional(),
    }),
    async run(ctx, { projectId: pid, fileId: fid, parentId, ...fields }) {
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>(path(pid, fid), defined({ ...fields, parentid: parentId })))));
    },
  }),
];
