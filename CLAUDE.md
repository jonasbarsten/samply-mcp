# samply-mcp

Remote MCP server for the Samply (samply.app) audio-sharing API. Samply
users sign in with their own personal access token and use it from Claude
(web, Desktop, iOS, Claude Code) and ChatGPT on their own plan. Full read
and write access to projects, files, players (links), comments and
webhooks. A sibling of `jonasbarsten/fiken-mcp`, which it follows wherever
Samply does not force a difference.

Repo: `jonasbarsten/samply-mcp` (public). AWS: byjoba account
(`--profile byjoba`), region eu-west-1, API at `api.samply-mcp.byjoba.com`
once the certificate exists (`samply-mcp.byjoba.com` itself is reserved
for a future site).

## Read these first

- `docs/superpowers/specs/2026-10-15-samply-mcp-design.md` is the design.
  Its section 3 marks which Samply API details are verified and which must
  be checked on the first live account; keep it current.
- `docs/superpowers/specs/2026-10-15-samply-mcp-decision-record.md` lists
  the alternatives we ruled out and why. Do not re-propose those.
- `docs/setup.md` is the one-time setup and the post-deploy checklist.

## Hard rules

- Store no user data: no tokens, no audio, no comments. The user's Samply
  token lives only inside our encrypted blobs. Only anonymous usage
  counters in DynamoDB.
- Audio bytes never pass through the Lambda: uploads go from the client to
  Samply's upload URL, downloads are links.
- One stable MCP App resource URI per widget. Never version it per build.
- All Samply API calls through one client (`api/src/samply/client.ts`),
  which is the only place the bearer token is set.
- Secrets in Parameter Store (`/samply_mcp/*`), read at cold start. Never
  in code, env vars or the CloudFormation template. Load the
  `aws-secrets-manager` skill before any secret handling and never fetch
  secret values into context.
- Deploy only via GitHub Actions. Feature branches and PRs; no direct
  pushes to main.
- No hard deletes of user content (trash is the reversible alternative).
- Keep the README up to date.

## New clients need allowlist entries

A new MCP client may need an entry in `KNOWN` in `api/src/auth/clients.ts`
(and the CIMD hosts there). Symptom: «redirect_uri is not a known MCP
client» at `/authorize`. Find the real value in logs, never guess; see
"Adding a new client" in `docs/setup.md`.

## Process

Foundation written 2026-10-15 (auth with a pasted token, the gateway and
operations, two widgets, both stacks, CI and deploy workflows, docs).
Next: the one-time setup in `docs/setup.md`, the first deploy, and the
live verification list there.
