# Samply MCP: design

Date: 2026-10-15
Status: implemented in the foundation pull request, not yet deployed
Companion: [Decision record](2026-10-15-samply-mcp-decision-record.md)
Model: [fiken-mcp](https://github.com/jonasbarsten/fiken-mcp), whose design
this follows wherever Samply does not force a difference.

## 1. What we are building

A remote MCP server that lets a Samply user work with their audio projects
from Claude (web, Desktop, iOS, Claude Code) and ChatGPT, on their own AI
subscription, after signing in with their own Samply personal access token.
Full read and write access to what Samply's API offers: projects, files,
folders and stacks, players (the app calls them Links), comments and
webhooks. Typical flows:

> "Which mixes did the client comment on this week, and what did they say?"

> "Make a link for the three newest versions in Album and send it to me."

> "Upload these stems to the Album project." (from Claude Code, where the
> files are on disk)

Nothing is stored on our side.

## 2. Non-negotiables

- **We store no user data.** No tokens, no audio, no comments. The only
  per-user records are anonymous usage counters.
- **Users bring their own Samply access.** A personal access token from
  samply.app/preferences/api, pasted once into our login page and sealed
  into the tokens we issue; we never see it again except inside requests.
- **Users pay for the model with their own Claude or ChatGPT plan.**
- **Everything happens inside the chat client.** The only page of ours a
  user sees is the login page the OAuth flow opens.
- **Audio bytes never pass through our Lambda.** Uploads go straight from
  the user's machine to the URL Samply hands out; downloads are links.

## 3. Facts the design rests on

Samply API (from docs.samply.app/api, read through search-engine snippets
on 2026-10-15 because the docs host was unreachable from the build
environment; each item is marked verified or to-verify):

- Base URL `https://samply.app/api/v0`, JSON, bearer auth. Verified.
- Authentication with personal access tokens, created at
  samply.app/preferences/api. The API is "available on team plans and upon
  request". Verified.
- Samply has OAuth for integrations, but not self-serve: a client id and
  secret are issued by Samply on request (contact in the authentication
  page). The flow is `samply.app/oauth/<service>` with `client_id`,
  `redirect_uri`, optional `state` and `error_uri`, then
  `POST /auth-token` with `client_id`, `client_secret` and `code`, which
  answers `{ access_token }`. No expiry or refresh is documented. Verified
  as far as the snippets go; not implemented (decision record).
- No "who am I" endpoint is documented. To verify: if one exists, the
  anonymous id should move to it (section 5).
- No rate limit or concurrency rule is documented. To verify in use.
- Projects: `GET /projects` (owned projects), `GET /projects/:id`,
  `POST /projects` (also creates a project-scoped player and returns
  `playerUrl`), `POST /projects/:id` to update (`name`, `upload`,
  `sortBy`). Project object: `id`, `object: "project"`, `name`, `artwork`,
  `color`, `creator`, `size` (bytes), `timeCreated`, `timeModified` (epoch
  millis), `upload`. No delete documented. Verified.
- Boxes (files, folders, stacks): `GET /projects/:id/all` (every box,
  hidden excluded), `GET /projects/:id/files/:boxId`,
  `POST /projects/:id/files/:boxId` to update (`name`, `addids`,
  `removeids`, `trashed`, `hidden`, `versionName`),
  `DELETE /projects/:id/files/:fileId` (also removes a stack whose last
  version it was), `GET /projects/:id/files/:fileId/download` →
  `{ url, expires }`, `POST /projects/:id/folders` (`name`, `color`),
  `POST /projects/:id/stacks` (`name`, `childids` ordered oldest first).
  Box object: `id`, `object` (`file` | `folder` | `stack`), `name`,
  `color`, `children`, `trashed`, `hidden`, `duration`, `timeCreated`.
  Verified except the folders path, which the snippet described rather
  than quoted; to verify on the first live call.
- Upload: `POST /projects/:id/files` with `name`, `mimeType`, `size`,
  optional `parentid` → `{ boxid, stackid, url, contentType, metadata,
  … }`; then `PUT` the bytes to `url` with "headers populated with fields
  from the previous response". Verified that a `url` comes back; the exact
  header field is to verify, so `request_upload` passes the whole answer
  through and builds the curl from a `headers` object when there is one.
- Players: `GET /players` (owned), `GET /players/:id`, `POST /players`
  (`name`, `projectid`, `folderid` or `boxids`, `public`, `upload`,
  `options`), `POST /players/:id` to update (`name`, `public`, `options`,
  `studio`, `stacks`). `public` omitted means the user's in-app default.
  `options` keys seen: `quality` (original | compressed | lossless),
  `metadata`, `isrc`, `downloads`, `comments`, loudness settings, `studio`,
  `stacks`. Verified; the player object's own link field was not in any
  snippet, so the operations return the object as Samply sends it.
- Comments: `GET` and `POST /projects/:id/files/:fileId/comments`; the id
  must be a file (version), a stack id creates nothing. Fields: `message`
  (Markdown), `audioTimestamp`, `audioTimestampEnd` (seconds), `parentid`,
  `pinned`, `completed`; object also has `creator`, `isReply`, `reactions`,
  `timeCreated`, `timeModified`. Verified.
- Webhooks: `POST /webhooks` (`label`, https `url` on 443 or 8443,
  `events`), `DELETE /webhooks/:id`; the signing secret `whsec_…` is
  returned once, on create. Events: `player.created`, `player.updated`,
  `project.created`, `project.updated`, `comment.created`,
  `upload.started`, `upload.completed`, `upload.failed`. Standard Webhooks
  signatures. No list endpoint documented. Verified.

Claude and ChatGPT clients: as verified by fiken-mcp (its spike and
production use): OAuth 2.1 with PKCE and dynamic registration or client id
metadata documents, MCP App widgets re-read by URI before each tool call,
widget messages via `sendMessage`.

## 4. Architecture

One CDK stack pair on the byjoba AWS account, region eu-west-1, repo
`jonasbarsten/samply-mcp` (public), deployed by GitHub Actions with OIDC.
The same shape as fiken-mcp:

```
Claude / ChatGPT client ──HTTPS──▶ API Gateway HTTP API
                                    api.samply-mcp.byjoba.com (Route 53 zone byjoba.com)
                                        │
                                        ▼
                                  Lambda (Node 24, arm64, reserved concurrency 10)
                                    /.well-known/*   OAuth discovery
                                    /register        dynamic client registration
                                    /authorize       login page: paste a Samply token
                                    /token           code exchange + refresh
                                    /mcp             MCP Streamable HTTP, stateless
                                    /stats           public usage counters
                                    /icon.png        connector icon
                                        │                    │
                                        ▼                    ▼
                                  samply.app/api/v0    DynamoDB (usage counters only)
```

Repository layout:

```
iac/   CDK app, stack samply-mcp-iac: the DynamoDB usage table, the deploy
       role (trusting the account's existing GitHub OIDC provider), the
       scoped execution policy, and, once the certificate exists, the API
       Gateway custom domain and its DNS record. Exports the table and the
       domain.
api/   Lambda source (TypeScript) and CDK app, stack samply-mcp-api:
       function, HTTP API, Parameter Store reads, domain mapping.
docs/  this spec, the decision record and the setup guide.
```

CI/CD, blast-radius containment and repo settings are fiken-mcp's, with
the names changed: bootstrap qualifier `samplymcp`, execution policy
`samply-mcp-cfn-exec` pinned to `samply-mcp-*` resources and
`/samply_mcp/*` parameters, deploy role `samply-mcp-github-deploy` trusting
only `repo:jonasbarsten@6729295/samply-mcp@1421261233:environment:production`.
One difference: the account already holds the GitHub OIDC provider (made by
fiken-mcp-iac, and an account can have only one per issuer), so this stack
references it by ARN, as byjoba-iac does.

Secrets: Parameter Store SecureStrings `/samply_mcp/signing_key` (key ring
for our blobs) and `/samply_mcp/user_salt`. No Samply app credentials
exist, because the user brings the token.

Domain: `CERTIFICATE_ARN` in `iac/lib/iac-stack.ts` is undefined until the
certificate is requested by hand; until then the iac stack holds no domain
and the api stack (`DOMAIN_ATTACHED` false) answers on its execute-api
address with `PUBLIC_URL` pointing there. Both flip in one change
(docs/setup.md).

## 5. Authentication: stateless OAuth with a pasted token

We are an OAuth 2.1 authorization server toward the MCP client. Toward
Samply we hold nothing: the user's personal access token is the
credential, and it travels only inside our encrypted blobs.

Keys, blobs, allowed clients, discovery, registration and client id
metadata documents are fiken-mcp's (sections 5 of its spec). What differs:

1. **Login page.** `GET /authorize` validates the client, redirect URI,
   PKCE challenge and state, sets a nonce cookie (`__Host-smcp_login`) and
   renders a page: which client wants access, a link to
   samply.app/preferences/api, and a password field for the token. The
   form posts back with the OAuth parameters, the nonce and the token.
2. **Check.** `POST /authorize` re-validates, checks the nonce against the
   cookie (CSRF), rejects an implausible token without any call, then asks
   Samply once with `GET /projects` under that token. A 401 or 403 shows
   the page again with an error (the token is never echoed back); another
   failure says Samply could not be reached. Nothing is logged but the
   status.
3. **Code.** On success we seal `{token, code_challenge, redirect_uri,
   exp: +5 min}` into an **encrypted** blob (it carries the token, so never
   a signed one) and send the browser back to the client with it as `code`
   and the client's state, through a meta-refresh page (a redirect from a
   form post would be checked against form-action by Chrome).
4. **Token.** The client posts the code and its PKCE verifier. We check
   the verifier, the redirect URI against the client, compute the
   anonymous id `HMAC(salt, token)` and return encrypted wrappers: an
   access token `{token, anon id, exp: +1 h}` and a refresh token
   `{token, anon id}`. No call to Samply here; the token was checked a
   moment ago.
5. **Refresh.** Personal access tokens do not expire, so a renewal re-wraps
   the same token, after one `GET /projects` to confirm it still works: a
   token revoked in Samply therefore stops working here within the hour
   (`invalid_grant`, and the client starts over at the login page). If
   Samply is down the answer is 503 `temporarily_unavailable`, so the
   client keeps its refresh token and tries again.
6. **Every MCP request** carries our wrapped access token; we decrypt it
   before any other work, send the Samply token upstream and count usage
   against the anonymous id. A Samply 401 or 403 with nothing written in
   the request, confirmed by one `GET /projects`, becomes HTTP 401 so the
   client refreshes; after a write it stays a tool error so the client
   cannot repeat the write.

Anonymous id: Samply documents no user endpoint, so the pseudonym is an
HMAC of the token itself under our salt. It is stable while the token is,
cannot be reversed, and changes when the user rotates the token (a new
"user" in the counters; accepted).

Revocation: the user deletes the token at samply.app/preferences/api. Our
wrappers are then dead within an hour. Disconnecting in Claude or ChatGPT
only forgets the wrappers.

## 6. Usage tracking, abuse limits, logging

As fiken-mcp: one on-demand DynamoDB table `samply-mcp-usage` with
pseudonymous monthly counters per tool, `my_usage` for the user and
`GET /stats` for everyone, two atomic updates after each tool call;
API Gateway throttling 20 r/s burst 40, reserved concurrency 10; structured
logs with no headers, bodies, tokens or Samply response bodies, 30-day
retention; a logger that refuses values that look like secrets.

Samply documents no concurrency limit, so there is no request queue: the
client retries a 429 once after a second, and that is all. A queue like
fiken-mcp's is the fix if Samply turns out to need one.

## 7. Tools

The gateway pattern from fiken-mcp: every Samply action is an `Operation`
in one registry (name, concept, read or write, destructive flag, zod
input, run). The tool list stays short:

- Hot path, real tools: `list_projects`, `list_items`, `list_players`,
  `list_comments`, `create_player`.
- Gateway: `samply_explore`, `samply_read`, `samply_write` (absent when the
  connection sees no write).
- Widgets, on every connection: `ask_user_choice`, `show_table` (columns
  of kind text, date, duration in seconds shown as m:ss, size in bytes
  shown as MB).

Concepts and operations (`read` unless marked write):

- `projects`: `list_projects` (owned projects, `nameContains` filter),
  `get_project`, `create_project` (write; collaborators by email and role;
  returns `playerUrl`), `update_project` (write)
- `files`: `list_items` (every box in a project, `kind` and `nameContains`
  filters, `limit`), `get_item`, `get_download_url` (a temporary link),
  `request_upload` (write; the upload URL plus a ready curl, for
  shell-capable clients; bytes never touch this server), `create_folder`
  (write), `create_stack` (write; file ids oldest first), `update_item`
  (write; rename, `addIds`, `removeIds`, `trashed`, `hidden`,
  `versionName`)
- `players`: `list_players` (`projectId` and `nameContains` filters),
  `get_player`, `create_player` (write; a project, a folder or chosen
  boxes; `public` shares with anyone holding the link), `update_player`
  (write)
- `comments`: `list_comments`, `create_comment` (write)
- `webhooks`: `create_webhook` (write; returns the secret once),
  `delete_webhook` (write)
- `usage`: `my_usage`

Conventions: ids are strings and come from the list operations; the
operations send Samply's own field names (`projectid`, `boxids`,
`childids`, `parentid`) while the inputs use camelCase; `timeCreated` and
`timeModified` come back as ISO strings; objects are otherwise passed
through as Samply sends them, since the documented fields are a subset of
what the API returns; unknown input keys are refused. `update_*` sends
only the fields given (Samply updates are partial), so there is no
read-modify-write.

Destructive flag (the host's confirmation prompt): `update_project`,
`update_item`, `create_player`, `update_player`, `create_comment`,
`delete_webhook`. Not destructive: `create_project`, `request_upload`,
`create_folder`, `create_stack`, `create_webhook`.

Left out on purpose: hard deletes of files, folders and stacks
(`update_item` with `trashed: true` is the reversible alternative) and
project deletion (undocumented). See the decision record.

Connector URL options: `/mcp/readonly`, `/mcp/<concept>,<concept>`, as
fiken-mcp: every read is always visible, writes only for the chosen
concepts, nothing is stored, not a security boundary.

## 8. Uploads and downloads

Downloads: `get_download_url` returns Samply's temporary URL; the user
opens it, or a shell client fetches it.

Uploads: `request_upload` does step one of Samply's two-step upload and
returns the URL, Samply's answer and a curl command for step two, so a
shell-capable client (Claude Code) can send a local file of any size
straight to Samply's storage. A chat-widget upload, as fiken-mcp has for
receipts, is deferred: the Lambda's request ceiling (about 4.5 MB raw)
makes proxying audio pointless, and a widget PUT straight to Samply's
storage needs that host in the widget's `connectDomains`, which can only
be learned from a real upload answer. Decision record.

## 9. Testing

Unit tests on every module, as fiken-mcp: blobs, PKCE, the login page and
form post (CSRF, token checks, error pages), token issue and refresh, the
MCP routes (401 mapping, option paths, batch refusal), the gateway, the
options, the registry's invariants (every operation named in a text says
which gateway runs it; writes say "Consequential"), each operation
against a fake Samply, the widgets' logic against a fake DOM and the built
pages, both CDK stacks, the deploy workflow. 214 tests at the first
commit. Live verification against a Samply account is the first thing to
do after the first deploy (docs/setup.md lists what to check).

## 10. Open items

- Verify on a live account: the folders path, the upload answer's header
  field, the player object's link field, whether a user endpoint exists,
  and any rate limit.
- Decide whether to ask Samply for OAuth credentials and replace the
  pasted token with a Samply login (decision record).
- A widget for uploads from a phone, once the storage host is known.
- A landing page on `samply-mcp.byjoba.com`, as fiken-mcp has.
