import { z } from "zod";
import { toolJson } from "../context.js";
import { defineOperation, type Operation } from "../operations.js";
import { CONFIRM, attempt, defined, playerId, projectId, type SamplyObject, toolText, withIsoTimes } from "./common.js";

const PUBLIC_NOTE = "public true means anyone with the link can listen; false limits it to the project's collaborators; leave it out to use the user's default from Samply's preferences.";

const options = z
  .object({
    quality: z.enum(["original", "compressed", "lossless"]).optional().describe("Streaming quality"),
    metadata: z.boolean().optional().describe("Show file metadata"),
    isrc: z.boolean().optional().describe("Show ISRC codes"),
    downloads: z.boolean().optional().describe("Let listeners download the files"),
    comments: z.boolean().optional().describe("Let listeners comment"),
  })
  .loose()
  .describe("Player options as Samply names them; keys beyond the known ones are passed through as given");

const uploadPortal = z
  .object({
    enabled: z.boolean().optional(),
    header: z.string().max(200).optional(),
    greeting: z.string().max(1000).optional(),
    redirect: z.string().url().optional(),
  })
  .strict()
  .describe("Let listeners upload files through the player");

const name = z.string().min(1).max(200);

export const playersOperations: Operation[] = [
  defineOperation({
    name: "list_players",
    concept: "players",
    kind: "read",
    destructive: false,
    title: "List players (links)",
    description:
      "Every player the user owns: its name, id, the project (projectid) or folder (folderid) or files (boxids) it plays, whether it is public, and its options. " +
      "The app calls players Links. Filter by projectId or nameContains to keep the answer short.",
    input: z.object({
      projectId: z.string().min(1).optional().describe("Keep only players of this project"),
      nameContains: z.string().optional().describe("Keep only players whose name contains this (case-insensitive)"),
    }),
    async run(ctx, { projectId: pid, nameContains }) {
      return attempt(ctx, async () => {
        const all = await ctx.samply.get<SamplyObject[]>("/players");
        const needle = nameContains?.trim().toLowerCase();
        const players = all.filter((pl) => (!pid || pl.projectid === pid) && (!needle || String(pl.name ?? "").toLowerCase().includes(needle)));
        return toolJson(players.map(withIsoTimes));
      });
    },
  }),

  defineOperation({
    name: "get_player",
    concept: "players",
    kind: "read",
    destructive: false,
    title: "Get player",
    description: "One player by id, with everything Samply holds about it.",
    input: z.object({ playerId }),
    async run(ctx, { playerId: id }) {
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.get<SamplyObject>(`/players/${encodeURIComponent(id)}`))));
    },
  }),

  defineOperation({
    name: "create_player",
    concept: "players",
    kind: "write",
    destructive: true,
    title: "Create a player (link)",
    description:
      "Share audio: create a player for a whole project (projectId alone), a folder (projectId and folderId) or chosen files (projectId and boxIds; not together with folderId). " +
      `${PUBLIC_NOTE} ${CONFIRM}`,
    input: z.object({
      name,
      projectId,
      folderId: z.string().min(1).optional().describe("A folder in the project to play; not with boxIds"),
      boxIds: z.array(z.string().min(1)).min(1).max(200).optional().describe("File or stack ids in the project to play; not with folderId"),
      public: z.boolean().optional(),
      upload: uploadPortal.optional(),
      options: options.optional(),
    }),
    async run(ctx, { projectId: pid, folderId, boxIds, ...rest }) {
      if (folderId && boxIds) return toolText("Give folderId or boxIds, not both.");
      return attempt(ctx, async () =>
        toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>("/players", defined({ ...rest, projectid: pid, folderid: folderId, boxids: boxIds })))),
      );
    },
  }),

  defineOperation({
    name: "update_player",
    concept: "players",
    kind: "write",
    destructive: true,
    title: "Update a player",
    description: `Rename a player, make it public or collaborators-only, or change its options. Only the fields you give are sent; at least one is required. ${PUBLIC_NOTE} ${CONFIRM}`,
    input: z.object({
      playerId,
      name: name.optional(),
      public: z.boolean().optional(),
      options: options.optional(),
    }),
    async run(ctx, { playerId: id, ...fields }) {
      const body = defined(fields);
      if (Object.keys(body).length === 0) return toolText("Give at least one field to change: name, public or options.");
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>(`/players/${encodeURIComponent(id)}`, body))));
    },
  }),
];
