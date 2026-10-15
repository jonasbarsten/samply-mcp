# Decision record: samply-mcp

Date: 2026-10-15
Purpose: what we chose, what we ruled out and why, so nobody re-explores
a dead end. Companion to the [design](2026-10-15-samply-mcp-design.md).
fiken-mcp's [decision record](https://github.com/jonasbarsten/fiken-mcp/blob/main/docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md)
applies to everything inherited (stateless OAuth, Parameter Store, where
the model runs, the gateway, connector options, blast-radius containment);
this one covers only where Samply differs.

## Auth: a pasted personal access token

**Chosen:** the user creates a personal access token in Samply and pastes
it into our login page once; it is sealed into the encrypted tokens we
issue and stored nowhere.

Why: Samply's documented way into its API is the personal access token,
and its terms do not forbid third-party use of it (unlike Fiken's). Samply
OAuth exists but is not self-serve: client credentials are issued by
Samply on request, by email, and the flow is documented only in outline.

Ruled out:

- **Samply OAuth now.** No credentials exist, the authorize path has a
  per-service segment whose value only Samply can give, and no token
  expiry or refresh is documented. Implementing it blind would ship
  untested code. Kept as the upgrade path: the auth module's upstream step
  is one function (`verifySamplyToken` plus the code blob), so a Samply
  login would replace the token field with a redirect, exactly as
  fiken-mcp does toward Fiken. Ask Samply for credentials once the
  connector has users.
- **Skipping the Samply check at login.** Without it a mistyped token
  would only fail at the first tool call, inside the chat, with a worse
  message. One `GET /projects` costs little.
- **A signed (not encrypted) authorization code.** The code carries the
  token, so it must be ciphertext. fiken-mcp's code blob is only signed
  because it carries Fiken's single-use code, not a credential.

## Anonymous id from the token

**Chosen:** `HMAC(salt, token)`.

Ruled out: **an id from a user endpoint.** None is documented. If one
turns up, switch to it so a rotated token keeps its pseudonym; the
counters are anonymous either way.

## Refresh checks the token every hour

**Chosen:** every refresh asks Samply `GET /projects` once.

Why: personal access tokens do not expire, so without the check a token
revoked in Samply would keep working through our wrapper for as long as
the client kept its refresh token. The check bounds that to an hour, the
same bound fiken-mcp gets from Fiken's refresh.

## No request queue

**Chosen:** no serialisation, one retry on 429.

Why: Samply documents no concurrency rule. fiken-mcp's queue exists for
Fiken's "one request at a time". Add a queue only if Samply answers 429 in
practice.

## Uploads: step one here, step two from the client

**Chosen:** `request_upload` returns Samply's upload URL and a curl; the
bytes go from the user's machine to Samply's storage.

Ruled out:

- **Proxying bytes through the Lambda** as fiken-mcp does for receipts.
  API Gateway and Lambda cap a request at about 4.5 MB of raw bytes; a
  mix is 50 MB and a stem session far more. Receipts fit, audio does not.
- **A chat widget that PUTs to Samply's storage.** Would work on phones
  and needs nothing of ours in the path, but the widget's CSP must name
  the storage host, which is only visible in a real upload answer. Build
  it after the first live upload shows the host.
- **Base64 in tool arguments.** Tokens per byte; impossible for audio.

## No hard deletes, no project delete

**Chosen:** `update_item` with `trashed: true` (reversible in Samply) and
nothing else. `delete_webhook` is the one delete, because a webhook the
model created should be removable by the model and it holds no content.

Ruled out: `DELETE /projects/:id/files/:id`, which is permanent and also
removes a stack whose last version it was. The same stance as fiken-mcp:
a mistake by the model must be correctable in the app. Project deletion is
not documented at all.

## Objects passed through, times converted

**Chosen:** operations return Samply's objects as sent, with
`timeCreated` and `timeModified` as ISO strings; `list_projects` is the
one trimmed list.

Why: the documented fields are a subset of what the API returns (the
snippets cut off), so trimming would hide fields the user may need. Epoch
milliseconds are converted because every model gets them wrong.

## Widgets: choice and table only

**Chosen:** port `ask_user_choice` and `show_table` from fiken-mcp.

Ruled out for now: the form, preview and document widgets. The preview is
accounting-specific, the document viewer renders PDFs, and the form has no
flow here that needs it yet. An audio player widget (play a file at a
comment's timestamp) is the natural addition once the download URL's CORS
behaviour is known.

## Things we decided not to do, on purpose

- A landing page. fiken-mcp's came in a later plan; the apex
  `samply-mcp.byjoba.com` stays free for it.
- Fetching Samply's docs from the Lambda for a help tool. Samply's docs are
  short and the model knows the concepts; fiken-mcp's help tool exists
  because Norwegian bookkeeping rules are not in the model.
- Listing webhooks: no endpoint is documented.
