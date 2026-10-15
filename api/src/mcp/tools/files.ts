import { z } from "zod";
import { toolJson } from "../context.js";
import { defineOperation, type Operation } from "../operations.js";
import { CONFIRM, attempt, defined, itemId, projectId, type SamplyObject, toolText, withIsoTimes } from "./common.js";

const KINDS = ["file", "folder", "stack"] as const;

const p = (id: string) => `/projects/${encodeURIComponent(id)}`;
const item = (projectIdValue: string, id: string) => `${p(projectIdValue)}/files/${encodeURIComponent(id)}`;

/** The upload URL answer, as far as Samply documents it; everything else in the answer is passed through too. */
interface UploadSlot extends SamplyObject {
  url?: string;
  headers?: Record<string, unknown>;
  boxid?: string;
  stackid?: string;
}

/** A single-quoted shell argument; the URL and header values come from Samply and must not break the command. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The curl that sends a local file to the upload URL, with the headers Samply asked for. */
export function uploadCurl(slot: UploadSlot, mimeType: string, localPath = "<path to the file>"): string | undefined {
  if (typeof slot.url !== "string") return undefined;
  const headers = Object.entries(slot.headers ?? {}).filter((e): e is [string, string] => typeof e[1] === "string");
  if (!headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", mimeType]);
  return ["curl --fail -X PUT", ...headers.map(([k, v]) => `-H ${sq(`${k}: ${v}`)}`), `--upload-file ${sq(localPath)}`, sq(slot.url)].join(" ");
}

export const filesOperations: Operation[] = [
  defineOperation({
    name: "list_items",
    concept: "files",
    kind: "read",
    destructive: false,
    title: "List a project's items",
    description:
      "Every file, folder and stack (box) in a project, hidden ones excluded. A stack holds versions of one file: its children are the versions, the last one the newest. " +
      "Comments and downloads take a file id, never a stack id. Filter by kind or nameContains to keep the answer short; show the result with show_table.",
    input: z.object({
      projectId,
      kind: z.enum(KINDS).optional().describe("Keep only files, folders or stacks"),
      nameContains: z.string().optional().describe("Keep only items whose name contains this (case-insensitive)"),
      limit: z.number().int().min(1).max(500).default(200).describe("At most this many items"),
    }),
    async run(ctx, { projectId: id, kind, nameContains, limit }) {
      return attempt(ctx, async () => {
        const all = await ctx.samply.get<SamplyObject[]>(`${p(id)}/all`);
        const needle = nameContains?.trim().toLowerCase();
        const items = all
          .filter((b) => (!kind || b.object === kind) && (!needle || String(b.name ?? "").toLowerCase().includes(needle)))
          .map(withIsoTimes);
        return toolJson({ items: items.slice(0, limit), total: items.length });
      });
    },
  }),

  defineOperation({
    name: "get_item",
    concept: "files",
    kind: "read",
    destructive: false,
    title: "Get a file, folder or stack",
    description: "One box by id: a file (with duration and size), a folder or a stack (with its versions as children).",
    input: z.object({ projectId, itemId }),
    async run(ctx, { projectId: pid, itemId: id }) {
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.get<SamplyObject>(item(pid, id)))));
    },
  }),

  defineOperation({
    name: "get_download_url",
    concept: "files",
    kind: "read",
    destructive: false,
    title: "Get a download link for a file",
    description: "A temporary URL that downloads the file's bytes, with when it expires. Takes a file id (a version inside a stack), not a stack or folder id. Give the link to the user or fetch it from a shell.",
    input: z.object({ projectId, fileId: z.string().min(1).describe("File id, from list_items or a stack's children") }),
    async run(ctx, { projectId: pid, fileId }) {
      return attempt(ctx, async () => toolJson(await ctx.samply.get<SamplyObject>(`${item(pid, fileId)}/download`)));
    },
  }),

  defineOperation({
    name: "request_upload",
    concept: "files",
    kind: "write",
    destructive: false,
    title: "Request an upload slot",
    description:
      "Step one of an upload: asks Samply for a temporary URL to PUT the file's bytes to, and returns it with a ready curl command. The bytes never pass through this server, so there is no size limit here. " +
      "Use it from a shell-capable client (Claude Code) with a local file; a chat client cannot upload through it. parentId puts the file in a folder, or adds it as a new version in a stack. " +
      "Nothing appears in Samply until the PUT completes; a slot that is never used is harmless.",
    input: z.object({
      projectId,
      name: z.string().min(1).max(255).describe("File name as it will appear, with extension"),
      mimeType: z.string().min(1).max(100).describe("The file's media type, e.g. audio/wav or audio/mpeg"),
      size: z.number().int().positive().describe("The file's size in bytes"),
      parentId: z.string().min(1).optional().describe("A folder or stack id to put the file in"),
      localPath: z.string().min(1).max(1000).optional().describe("The local path to put in the curl command"),
    }),
    async run(ctx, { projectId: pid, name, mimeType, size, parentId, localPath }) {
      return attempt(ctx, async () => {
        const slot = await ctx.samply.post<UploadSlot>(`${p(pid)}/files`, defined({ name, mimeType, size, parentid: parentId }));
        const curl = uploadCurl(slot, mimeType, localPath);
        return toolJson({ ...slot, curl, note: curl ? "Run the curl with the real file path, then confirm with list_items (via samply_read)." : "Samply returned no upload url." });
      });
    },
  }),

  defineOperation({
    name: "create_folder",
    concept: "files",
    kind: "write",
    destructive: false,
    title: "Create a folder",
    description: "Create a folder in a project. Move items into it afterwards with update_item (via samply_write) and its addIds.",
    input: z.object({
      projectId,
      name: z.string().min(1).max(200),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Folder colour as #rrggbb"),
    }),
    async run(ctx, { projectId: pid, ...fields }) {
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>(`${p(pid)}/folders`, defined(fields)))));
    },
  }),

  defineOperation({
    name: "create_stack",
    concept: "files",
    kind: "write",
    destructive: false,
    title: "Create a stack of versions",
    description: "Group files into a stack, where each child is a version of the same piece: give the file ids in order, oldest first, newest last.",
    input: z.object({
      projectId,
      name: z.string().min(1).max(200),
      childIds: z.array(z.string().min(1)).min(1).max(100).describe("File ids, oldest version first"),
    }),
    async run(ctx, { projectId: pid, name, childIds }) {
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>(`${p(pid)}/stacks`, { name, childids: childIds }))));
    },
  }),

  defineOperation({
    name: "update_item",
    concept: "files",
    kind: "write",
    destructive: true,
    title: "Rename, move, trash or hide an item",
    description:
      "Change a file, folder or stack: rename it, add items to a folder or stack (addIds) or take them out (removeIds), move it to the trash (trashed true; the user restores it in Samply) or hide it, or name a version. " +
      `Only the fields you give are sent; at least one is required. There is no permanent delete here on purpose. ${CONFIRM}`,
    input: z.object({
      projectId,
      itemId,
      name: z.string().min(1).max(255).optional(),
      addIds: z.array(z.string().min(1)).max(100).optional().describe("Item ids to put into this folder or stack"),
      removeIds: z.array(z.string().min(1)).max(100).optional().describe("Item ids to take out of this folder or stack"),
      trashed: z.boolean().optional().describe("true moves it to the trash, false restores it"),
      hidden: z.boolean().optional(),
      versionName: z.string().max(200).optional().describe("A label for this version, when the item is a file in a stack"),
    }),
    async run(ctx, { projectId: pid, itemId: id, addIds, removeIds, ...rest }) {
      const body = defined({ ...rest, addids: addIds, removeids: removeIds });
      if (Object.keys(body).length === 0) return toolText("Give at least one field to change: name, addIds, removeIds, trashed, hidden or versionName.");
      return attempt(ctx, async () => toolJson(withIsoTimes(await ctx.samply.post<SamplyObject>(item(pid, id), body))));
    },
  }),
];
