# One-time setup

Everything here is done once by Jonas. Nothing in it needs repeating for
normal development. The shape is fiken-mcp's `docs/setup.md`; the
differences are the names, the missing Samply app (none is needed) and the
GitHub OIDC provider, which already exists in the account.

## AWS (byjoba, eu-west-1)

1. Parameter Store SecureStrings. Create:
   - `/samply_mcp/signing_key`: the value `k1:<64 hex>` where the hex comes
     from `openssl rand -hex 32`. To rotate later, prepend `k2:<hex>,`.
   - `/samply_mcp/user_salt`: 64 hex characters from `openssl rand -hex 32`.
   Use the console or `aws ssm put-parameter --type SecureString`. Never
   paste the values anywhere else. There is no client id or secret: users
   bring their own Samply token.
2. Bootstrap and first deploy, from `iac/`, in this order:
   ```
   npx cdk bootstrap aws://209479295726/eu-west-1 --qualifier samplymcp --profile byjoba
   npx cdk deploy samply-mcp-iac --profile byjoba
   npx cdk bootstrap aws://209479295726/eu-west-1 --qualifier samplymcp \
     --cloudformation-execution-policies arn:aws:iam::209479295726:policy/samply-mcp-cfn-exec \
     --profile byjoba
   ```
   The second bootstrap swaps the execution role's AdministratorAccess for
   the scoped policy the first deploy created. The iac stack references
   the account's GitHub OIDC provider
   (`arn:aws:iam::209479295726:oidc-provider/token.actions.githubusercontent.com`,
   created by fiken-mcp-iac) and does not create one; it must exist.
   Note the `DeployRoleArn` output.
3. Certificate for `api.samply-mcp.byjoba.com`, requested once by hand so
   that CloudFormation never needs certificate-request rights, in
   eu-west-1:
   ```
   aws acm request-certificate --domain-name api.samply-mcp.byjoba.com \
     --validation-method DNS --tags Key=Project,Value=samply-mcp \
     --region eu-west-1 --profile byjoba
   ```
   Add the validation CNAME to the byjoba.com zone (ACM console, "Create
   records in Route 53"), wait for ISSUED, then in one pull request set
   `CERTIFICATE_ARN` in `iac/lib/iac-stack.ts` and `DOMAIN_ATTACHED = true`
   in `api/lib/api-stack.ts`. Until then the API answers only on its
   execute-api address (the `ApiUrl` output), which also works for
   testing: `PUBLIC_URL` follows it.
4. Account Lambda concurrency quota: the function reserves 10; the byjoba
   account's quota was raised to 1000 for fiken-mcp, so nothing to do.

## GitHub (jonasbarsten/samply-mcp)

1. Settings, Actions, General, OpenID Connect: turn on "Use immutable
   subject" (the deploy role trusts
   `repo:jonasbarsten@6729295/samply-mcp@1421261233:environment:production`;
   check it with `gh api repos/jonasbarsten/samply-mcp/actions/oidc/customization/sub`).
2. Settings, Environments, New environment `production`: required
   reviewers: jonasbarsten; deployment branches: `main` only. Leave
   "Prevent self-review" off. This approval is the gate that decides what
   reaches AWS.
3. Settings, Secrets and variables, Actions, Variables:
   `AWS_DEPLOY_ROLE_ARN` = the DeployRoleArn output.
4. Settings, Branches, rule for `main`: require a pull request, require
   status check `check`, block direct pushes, include administrators.
   Required approvals 0 while you are the only maintainer (an author
   cannot approve their own pull request); 1 plus "require review from
   code owners" once a second contributor joins.
5. Settings, Actions, General: workflow permissions read-only; "Require
   approval for all outside collaborators".
6. Settings, Code security: secret scanning with push protection,
   Dependabot alerts and security updates.
7. Settings, Account: two-factor authentication required.

## Samply

Nothing to register. Each user creates a personal access token at
https://samply.app/preferences/api and pastes it into the login page the
connector opens. The API is available on Samply's team plans and on
request; a user on another plan gets "Samply did not accept that token".

If Samply later issues OAuth credentials for this connector, they go into
Parameter Store as `/samply_mcp/client_id` and `/samply_mcp/client_secret`
and the login page is replaced by a redirect; see the decision record.

## First deploy

Merge the first pull request to `main`, approve the `production`
deployment when GitHub asks, and watch the `deploy` workflow. On a fresh
account the `changes` job finds no earlier successful deploy and deploys
both stacks.

## Verify after the first deploy

With the `ApiUrl` output as `<url>` (the execute-api address until the
domain is attached):

- `GET <url>/` answers `samply-mcp`; `GET <url>/.well-known/oauth-authorization-server`
  names `<url>/authorize` and `<url>/token`; `GET <url>/icon.png` is a PNG;
  `GET <url>/stats` is JSON.
- `claude mcp add --transport http samply <url>/mcp`, then `/mcp` in Claude
  Code: the login page opens, a pasted token is checked, the tools appear.
- `list_projects`, `list_items` on one project, `list_players`,
  `list_comments` on a file.
- The unverified API details from the design spec, section 3:
  `create_folder`'s path, the `headers` in `request_upload`'s answer (and
  that its curl works with a real file), the link field on a player
  object. Fix the operations if Samply differs, and move each item to
  "verified" in the spec.
- A revoked token: delete it in Samply, wait for the hourly refresh, and
  see the client ask to log in again.

## Adding a new client

A new MCP client (or a new app of one we support) may be refused by the
redirect URI allowlist `KNOWN` in `api/src/auth/clients.ts` (and the CIMD
hosts there). The symptom is «redirect_uri is not a known MCP client» or
«redirect_uri not registered for this client» at `/authorize`. Read the
real redirect URI from the request log's `/register` body or the
`/authorize` query in the browser, never guess, and add it by pull
request. The widget-origin allowlist fiken-mcp also has does not exist
here: no widget of ours calls back to the API.
