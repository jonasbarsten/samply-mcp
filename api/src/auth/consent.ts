function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const STYLE = `
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.5rem; }
    label { display: block; margin: 1rem 0 .4rem; font-weight: 600; }
    input[type=password] { width: 100%; box-sizing: border-box; font-size: 1rem; padding: .6rem .75rem; border: 1px solid #999; border-radius: 8px; font-family: ui-monospace, monospace; }
    button { font-size: 1rem; padding: .75rem 1.25rem; border-radius: 8px; border: 0; background: #1f6feb; color: #fff; margin-top: 1rem; }
    .cancel { display: inline-block; padding: .75rem 1.25rem; border-radius: 8px; background: #eee; color: #222; text-decoration: none; margin-left: .5rem; }
    .muted { color: #666; font-size: .9rem; }
    .error { color: #b00020; font-weight: 600; }`;

export interface ConsentOptions {
  clientLabel: string;
  clientName: string;
  redirectHost: string;
  fields: Record<string, string>;
  cancelUrl: string;
  tokenPageUrl: string;
  /** Shown above the form when a previous attempt failed; the token itself is never echoed back. */
  error?: string;
}

/**
 * The login page: names the client, explains that a Samply personal access token is needed and takes
 * it in a password field that posts back to /authorize together with the OAuth parameters. Samply
 * has no self-serve OAuth (its OAuth needs credentials issued by Samply), so this is the login.
 */
export function consentPage(opts: ConsentOptions): string {
  const hidden = Object.entries(opts.fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n      ");
  // "Claude via Claude (claude.ai)" reads badly; only add the name when it says something the label does not.
  const nameAddsInformation = opts.clientName !== "" && !opts.clientLabel.toLowerCase().startsWith(opts.clientName.toLowerCase());
  const who = nameAddsInformation ? `${esc(opts.clientName)} via ${esc(opts.clientLabel)}` : esc(opts.clientLabel);
  const error = opts.error ? `<p class="error">${esc(opts.error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect to Samply</title>
  <style>${STYLE}
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect to Samply</h1>
    <p><strong>${who}</strong> asks for access to your Samply account through Samply MCP.</p>
    <p class="muted">Samply MCP signs in with a personal access token. Create one in Samply under Preferences → API (<a href="${esc(opts.tokenPageUrl)}" rel="noopener" target="_blank">${esc(opts.tokenPageUrl)}</a>) and paste it below. The token is sealed into the login that ${esc(opts.redirectHost)} keeps; this server stores nothing. Revoke it on the same page to end the access.</p>
    ${error}
    <form method="post" action="/authorize" autocomplete="off">
      ${hidden}
      <label for="samply_token">Personal access token</label>
      <input type="password" id="samply_token" name="samply_token" required autocomplete="off" spellcheck="false">
      <div>
        <button type="submit">Connect</button>
        <a class="cancel" href="${esc(opts.cancelUrl)}">Cancel</a>
      </div>
    </form>
  </div>
</body>
</html>
`;
}

/**
 * Shown for an instant after "Connect": sends the browser back to the client with a meta refresh. A
 * redirect straight from the form post would be checked by Chrome against form-action for every hop
 * the client then takes; a meta refresh is a plain document navigation that CSP does not govern.
 */
export function continuePage(backUrl: string, clientLabel: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${esc(backUrl)}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Back to ${esc(clientLabel)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  </style>
</head>
<body>
  <p>Connected. Taking you back to ${esc(clientLabel)} … <a href="${esc(backUrl)}">Click here if nothing happens.</a></p>
</body>
</html>
`;
}
