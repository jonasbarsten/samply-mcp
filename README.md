<p align="center">
  <img src="api/src/assets/icon.png" alt="" width="112" height="112">
</p>

<h1 align="center">Samply MCP</h1>

<p align="center">
  <strong>Your Samply projects, from Claude and ChatGPT.</strong><br>
  Browse files and versions, share links, read and leave comments, in plain language.
</p>

<p align="center">
  <a href="https://github.com/jonasbarsten/samply-mcp/actions/workflows/ci.yml"><img src="https://github.com/jonasbarsten/samply-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT licence"></a>
</p>

---

A remote [MCP](https://modelcontextprotocol.io) server for the
[Samply](https://samply.app) audio-sharing API. A sibling of
[Fiken MCP](https://github.com/jonasbarsten/fiken-mcp), built the same way:
you sign in with your own Samply access and use it on your own AI
subscription, and nothing is stored on the server.

Status: written, not yet deployed. The one-time setup is in
[docs/setup.md](docs/setup.md); the address will be
`https://api.samply-mcp.byjoba.com/mcp` once it is live.

## Getting started

You need:

- a Samply account whose plan includes the API (Samply says: team plans,
  or on request)
- a personal access token from Samply: **Preferences › API**
  (https://samply.app/preferences/api)
- Claude or ChatGPT

**Claude** (mobile, web and desktop):

1. Go to **Customize › Connectors**.
2. Press **Add** and choose **Add custom connector**.
3. Give it a name, for example Samply, and paste
   `https://api.samply-mcp.byjoba.com/mcp`.
4. A login page opens: paste your Samply token and press **Connect**.

**Claude Code:**

```
claude mcp add --transport http samply https://api.samply-mcp.byjoba.com/mcp
```

**ChatGPT** (mobile, web and desktop): set it up once on chatgpt.com in
the browser, Plugins → Add → Create custom MCP server, with the same
address and OAuth. It then works in the mobile and desktop apps too.

To end the access, delete the token in Samply under Preferences › API.
Disconnecting in Claude or ChatGPT only makes that app forget its login.

## What it can do

Everything Samply's API documents, except permanent deletes: a file,
folder or stack can be moved to the trash (and restored in Samply), never
deleted outright, so a mistake by Claude or ChatGPT can always be
corrected in Samply. If Claude or ChatGPT should only read, use
`https://api.samply-mcp.byjoba.com/mcp/readonly`.

## Examples

| You write | Claude or ChatGPT does |
|---|---|
| "What did the client say about the latest mix of Northern Lights?" | Finds the project, the stack and its newest version, lists the comments with their timestamps |
| "Make a link to the three newest masters in Album, collaborators only." | Creates a player over those files with `public: false` and gives you the link |
| "Upload these two stems to Album." (in Claude Code) | Asks Samply for an upload slot per file and runs the curl that sends the bytes straight to Samply |
| "Reply to Anna's comment at 1:12 that the vocal is fixed in v4." | Posts a reply on that comment, after you confirm the text |
| "Which projects have I not touched since August?" | Lists projects by `timeModified` |

## Privacy and responsibility

Nothing you send is stored. Your Samply token is sealed into the login
that Claude or ChatGPT keeps and is decrypted only inside a request on its
way to Samply. Audio never passes through the server: uploads go from
your machine to Samply's storage, downloads are links. Only anonymous
usage counters are kept ([details](#privacy)).

This is something I made in my spare time, not affiliated with Samply,
provided as is under the [MIT licence](LICENSE). Claude and ChatGPT can
make mistakes; you are responsible for what is shared, commented or
changed in your account. Check the result in Samply.

## How it works

```
Claude / ChatGPT ──MCP over HTTPS──▶ API Gateway ──▶ Lambda (Hono) ──▶ samply.app/api/v0
        ▲                                               │
        └──── OAuth: you paste a Samply token once ◀────┘
```

One stateless Lambda serves MCP (`/mcp`), OAuth (`/authorize`, `/token`,
`/register`, discovery), `/stats` and the connector icon. We are an OAuth
2.1 authorization server toward the client; toward Samply we hold nothing
but the token you pasted, inside encrypted blobs the client carries. Every
refresh asks Samply once whether the token still works, so a token you
delete in Samply stops working here within the hour.

## Tools

A short, fixed tool list instead of one tool per Samply action:

- The hot-path tools: `list_projects`, `list_items`, `list_players`,
  `list_comments`, `create_player`.
- `ask_user_choice`: a question with 2-12 options as buttons in clients
  that render widgets (others get a numbered list); the answer comes back
  as your next chat message.
- `show_table`: rows as a table with up to 3 action buttons per row;
  `duration` columns take seconds and show m:ss, `size` columns take bytes
  and show MB.
- The gateway: `samply_explore`, `samply_read` and `samply_write`.
  `samply_explore` lists the concepts, then a concept's operations with
  their inputs as JSON Schema. `samply_read` runs a read operation and
  `samply_write` a write operation, each taking the operation's name and
  its `args`; a write sent to `samply_read`, an unknown name, a key beside
  `operation` and `args`, or args that do not match the input are refused
  before any call to Samply. Unknown keys are refused rather than dropped.
  `samply_write` is absent on a read-only connection.

Operations by concept (`read` unless marked write):

- `projects`: `list_projects` (the projects you own, filter by name),
  `get_project`, `create_project` (write; optional collaborators by email
  and role; Samply also makes a project player and returns its
  `playerUrl`), `update_project` (write; name, upload portal, file order)
- `files`: `list_items` (every file, folder and stack in a project, filter
  by kind or name), `get_item`, `get_download_url` (a temporary link to
  the bytes), `request_upload` (write; step one of Samply's two-step
  upload: the upload URL plus a ready `curl` for a shell-capable client
  such as Claude Code; the bytes go straight to Samply, so there is no
  size limit here), `create_folder` (write), `create_stack` (write; file
  ids oldest first), `update_item` (write; rename, move items in or out,
  trash or restore, hide, name a version)
- `players`: `list_players` (filter by project or name), `get_player`,
  `create_player` (write; a whole project, a folder, or chosen files and
  stacks; `public` true means anyone with the link can listen),
  `update_player` (write; name, public, options)
- `comments`: `list_comments` (on a file, that is a version; a stack has
  none), `create_comment` (write; at a timestamp or over a range, or as a
  reply; Markdown)
- `webhooks`: `create_webhook` (write; the signing secret is returned
  once, in the answer), `delete_webhook` (write)
- `usage`: `my_usage` (your own pseudonymous monthly call counts)

Ids are strings from the list operations. The inputs use camelCase
(`projectId`, `boxIds`, `childIds`, `parentId`); the operations send
Samply's own names. `timeCreated` and `timeModified` come back as ISO
strings. Every write that others can see at once, or that changes an
existing item, asks the model to restate the action and get your explicit
confirmation first.

Not covered on purpose: permanent deletes of files, folders, stacks and
projects. Not yet: an upload widget for phones (the upload goes to
Samply's storage host, which must be allowed in the widget first), an
audio player widget, a landing page.

### Connector URL options

| URL | What the connection offers |
| --- | --- |
| `https://api.samply-mcp.byjoba.com/mcp` | Everything |
| `https://api.samply-mcp.byjoba.com/mcp/readonly` | Reads only; no write operation, no `samply_write` |
| `https://api.samply-mcp.byjoba.com/mcp/players,comments` | Every read; writes only in those concepts |

Concept names: `projects`, `files`, `players`, `comments`, `webhooks`,
`usage`. All reads stay available under a concept filter, since writes
take their ids from reads in other concepts. These options narrow what a
connection offers the model; they are not a security boundary against
whoever holds the login, since the same login works on `/mcp`. To stop a
login, delete the token in Samply.

## Privacy

We hold a signing key and a salt, nothing per user. We never store your
Samply token, your audio or your comments. We keep anonymous usage
counters keyed by a salted hash of your token that we cannot reverse:
pseudonymous monthly call counts per tool, and whether each call
succeeded. Ask for your own counters with the `my_usage` operation
(through `samply_read`), or see the same counts aggregated across every
user at `https://api.samply-mcp.byjoba.com/stats`. Rotating your token
makes you a new pseudonym.

## Development

```
npm ci
npm run typecheck
npm test          # builds the widgets first
npm run synth
```

Node 24. `api/` is the Lambda and its CDK stack, `iac/` the static stack.
Never `cdk deploy` from a machine; merges to `main` deploy through GitHub
Actions after approval. The Samply API details the code rests on, and
which of them still need a live check, are in the
[design](docs/superpowers/specs/2026-10-15-samply-mcp-design.md); the
alternatives we ruled out are in the
[decision record](docs/superpowers/specs/2026-10-15-samply-mcp-decision-record.md).

## Licence

MIT, see [LICENSE](LICENSE).
