import { z } from "zod";
import { toolJson } from "../context.js";
import { defineOperation, type Operation } from "../operations.js";
import { CONFIRM, attempt, defined, projectId, type SamplyObject, withIsoTimes } from "./common.js";

const uploadPortal = z
  .object({
    enabled: z.boolean().optional().describe("Whether the project's public upload portal is on"),
    header: z.string().max(200).optional().describe("Heading shown on the upload portal"),
    greeting: z.string().max(1000).optional().describe("Text shown on the upload portal"),
    redirect: z.string().url().optional().describe("Where the portal sends people after an upload"),
  })
  .strict();

const collaborator = z
  .object({
    email: z.string().email(),
    role: z.enum(["admin", "editor", "viewer"]),
  })
  .strict();

const sortBy = z
  .object({
    criterion: z.string().min(1).describe("custom, name, duration, size or an audio metadata field"),
    ascending: z.boolean(),
  })
  .strict();

const name = z.string().min(1).max(200);

export const projectsOperations: Operation[] = [
  defineOperation({
    name: "list_projects",
    concept: "projects",
    kind: "read",
    destructive: false,
    title: "List projects",
    description:
      "The projects the user owns, with the id every project-scoped operation takes as projectId. Projects shared with the user by others are not listed by Samply's API. " +
      "Filter by nameContains when the user names one; when several could match, let the user pick with ask_user_choice.",
    input: z.object({
      nameContains: z.string().optional().describe("Keep only projects whose name contains this (case-insensitive)"),
    }),
    async run(ctx, { nameContains }) {
      return attempt(ctx, async () => {
        const all = await ctx.samply.get<SamplyObject[]>("/projects");
        const needle = nameContains?.trim().toLowerCase();
        const projects = needle ? all.filter((p) => String(p.name ?? "").toLowerCase().includes(needle)) : all;
        return toolJson(projects.map((p) => withIsoTimes({ id: p.id, name: p.name, size: p.size, color: p.color, timeCreated: p.timeCreated, timeModified: p.timeModified })));
      });
    },
  }),

  defineOperation({
    name: "get_project",
    concept: "projects",
    kind: "read",
    destructive: false,
    title: "Get project",
    description: "One project by id, with its artwork, creator, size in bytes and upload portal settings.",
    input: z.object({ projectId }),
    async run(ctx, { projectId: id }) {
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.get<SamplyObject>(`/projects/${encodeURIComponent(id)}`))));
    },
  }),

  defineOperation({
    name: "create_project",
    concept: "projects",
    kind: "write",
    destructive: false,
    title: "Create project",
    description:
      "Create a project. Samply also creates a project-scoped player and returns its link as playerUrl. " +
      "Collaborators are invited by email with a role (admin, editor or viewer); leave them out unless the user asked for them.",
    input: z.object({
      name,
      upload: uploadPortal.optional(),
      collaborators: z.array(collaborator).max(50).optional(),
      sortBy: sortBy.optional(),
    }),
    async run(ctx, fields) {
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>("/projects", defined(fields)))));
    },
  }),

  defineOperation({
    name: "update_project",
    concept: "projects",
    kind: "write",
    destructive: true,
    title: "Update project",
    description: `Rename a project or change its upload portal or file order. Only the fields you give are sent; at least one is required. ${CONFIRM}`,
    input: z.object({
      projectId,
      name: name.optional(),
      upload: uploadPortal.optional(),
      sortBy: sortBy.optional(),
    }),
    async run(ctx, { projectId: id, ...fields }) {
      const body = defined(fields);
      if (Object.keys(body).length === 0) return { content: [{ type: "text", text: "Give at least one field to change: name, upload or sortBy." }], isError: true };
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>(`/projects/${encodeURIComponent(id)}`, body))));
    },
  }),
];
