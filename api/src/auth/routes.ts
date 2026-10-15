import { randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.js";
import { BlobError, decryptBlob, encryptBlob, signBlob } from "../crypto/blob.js";
import { verifyPkce } from "../crypto/pkce.js";
import { log } from "../log.js";
import { parseConnectorOptions } from "../mcp/options.js";
import { SamplyError } from "../samply/client.js";
import { SamplyLoginError, isPlausibleToken, verifySamplyToken } from "../samply/login.js";
import { anonymousId } from "./anon.js";
import { resolveClient } from "./cimd.js";
import { type ClientWire, clientLabel, isAllowedRedirectUri, isRegisteredRedirectUri } from "./clients.js";
import { consentPage, continuePage } from "./consent.js";
import { issueTokens, renewTokens } from "./tokens.js";

/**
 * The authorization code we hand the client. It carries the user's Samply token, so it is an
 * encrypted blob (`v1e.`), never a signed one; `k: "d"` keeps it apart from access and refresh wrappers.
 */
export interface CodeWire { k: "d"; st: string; cc: string; ru: string; exp: number }

const LOGIN_WINDOW_SECONDS = 60 * 60;
const CODE_WINDOW_SECONDS = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

/**
 * Binds the login to the browser that saw the consent page: the nonce is set as a cookie on
 * GET /authorize and must be echoed by the form on POST, so a cross-site form post (which carries
 * neither our page's field nor, with SameSite=Lax, the cookie) cannot submit a token on the user's
 * behalf or start a login.
 */
const LOGIN_COOKIE = "__Host-smcp_login";
const LOGIN_COOKIE_ATTRS = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" } as const;

function nonceMatches(cookie: string | undefined, expected: string): boolean {
  if (!cookie) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface AuthorizeRequest { redirectUri: string; codeChallenge: string; clientState: string; clientName: string }

/** Validates authorize parameters; returns an error message or the validated request. */
async function validateAuthorize(cfg: Config, q: Record<string, string | undefined>): Promise<{ error: string } | { ok: AuthorizeRequest }> {
  if (q.response_type !== "code") return { error: "response_type must be code" };
  let client: { redirectUris: string[]; name: string };
  try {
    client = await resolveClient(cfg, q.client_id ?? "");
  } catch {
    return { error: "invalid client_id" };
  }
  const redirectUri = q.redirect_uri ?? "";
  if (!isRegisteredRedirectUri(client.redirectUris, redirectUri)) return { error: "redirect_uri not registered for this client" };
  // Re-checked on every use so removing a client from clients.ts takes effect at once.
  if (!isAllowedRedirectUri(redirectUri)) return { error: "redirect_uri is not a known MCP client" };
  if (q.code_challenge_method !== "S256" || !q.code_challenge) return { error: "PKCE S256 required" };
  return { ok: { redirectUri, codeChallenge: q.code_challenge, clientState: q.state ?? "", clientName: client.name } };
}

/**
 * form-action stays 'self': the consent form posts to /authorize and the answer is a page, never a
 * redirect. Chrome checks form-action against every hop of a redirect chain after a form post, and
 * the client's own callback redirects are not ours to allowlist.
 */
const CONSENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PAGE_HEADERS = { "Content-Security-Policy": CONSENT_CSP, "Cache-Control": "no-store" };

/** A JSON body can carry anything; every field the token endpoint reads is a string or "". */
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TOKEN_FIELDS = ["grant_type", "code", "code_verifier", "redirect_uri", "client_id", "refresh_token"] as const;

function tokenFields(raw: Record<string, unknown>): Record<(typeof TOKEN_FIELDS)[number], string> {
  return Object.fromEntries(TOKEN_FIELDS.map((f) => [f, str(raw[f])])) as Record<(typeof TOKEN_FIELDS)[number], string>;
}

/** The OAuth parameters the consent form carries back, without the token or the nonce. */
const OAUTH_FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"] as const;

export function authRoutes(cfg: Config): Hono {
  const app = new Hono();

  const protectedResource = (resourcePath: string) => ({
    resource: `${cfg.publicUrl}${resourcePath}`,
    authorization_servers: [cfg.publicUrl],
    bearer_methods_supported: ["header"],
  });

  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource("/mcp")));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource("/mcp")));
  // Mirrors the connector option path (RFC 9728 section 3.1): the resource is the raw path the client connected to.
  app.get("/.well-known/oauth-protected-resource/mcp/:options", (c) => {
    if ("error" in parseConnectorOptions(c.req.param("options"))) return c.notFound();
    return c.json(protectedResource(new URL(c.req.url).pathname.slice("/.well-known/oauth-protected-resource".length)));
  });

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: cfg.publicUrl,
      authorization_endpoint: `${cfg.publicUrl}/authorize`,
      token_endpoint: `${cfg.publicUrl}/token`,
      registration_endpoint: `${cfg.publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    }),
  );

  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { client_name?: unknown; redirect_uris?: unknown };
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
      return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris required" }, 400);
    }
    if (!uris.every(isAllowedRedirectUri)) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uri is not a known MCP client" }, 400);
    }
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 64) : "";
    const wire: ClientWire = { k: "c", ru: uris, n: name };
    return c.json(
      {
        client_id: signBlob(wire, cfg.keys),
        client_name: name || undefined,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  /** The consent page for a validated request, with a fresh nonce in the cookie and the form. */
  function renderConsent(c: Context, q: Record<string, string | undefined>, v: AuthorizeRequest, error?: string) {
    const nonce = randomBytes(16).toString("base64url");
    setCookie(c, LOGIN_COOKIE, nonce, { ...LOGIN_COOKIE_ATTRS, maxAge: LOGIN_WINDOW_SECONDS });
    const fields: Record<string, string> = { nonce };
    for (const f of OAUTH_FIELDS) fields[f] = q[f] ?? "";
    fields.redirect_uri = v.redirectUri;
    fields.state = v.clientState;
    const cancel = new URL(v.redirectUri);
    cancel.searchParams.set("error", "access_denied");
    cancel.searchParams.set("error_description", "User cancelled");
    cancel.searchParams.set("state", v.clientState);
    const html = consentPage({
      clientLabel: clientLabel(v.redirectUri),
      clientName: v.clientName,
      redirectHost: new URL(v.redirectUri).host,
      fields,
      cancelUrl: cancel.toString(),
      tokenPageUrl: cfg.samplyTokenPageUrl,
      error,
    });
    return c.html(html, error ? 400 : 200, PAGE_HEADERS);
  }

  app.get("/authorize", async (c) => {
    const q = c.req.query();
    const v = await validateAuthorize(cfg, q);
    if ("error" in v) return c.text(v.error, 400);
    return renderConsent(c, q, v.ok);
  });

  app.post("/authorize", async (c) => {
    const q = Object.fromEntries(new URLSearchParams(await c.req.text())) as Record<string, string>;
    const v = await validateAuthorize(cfg, q);
    if ("error" in v) return c.text(v.error, 400);
    const nonce = q.nonce ?? "";
    if (nonce === "" || !nonceMatches(getCookie(c, LOGIN_COOKIE), nonce)) {
      return c.text("This form did not come from this browser or has expired. Go back to the app and connect again.", 400);
    }
    const token = (q.samply_token ?? "").trim();
    if (!isPlausibleToken(token)) return renderConsent(c, q, v.ok, "Paste the personal access token from Samply (one line, no spaces).");
    try {
      await verifySamplyToken(cfg, token);
    } catch (err) {
      if (err instanceof SamplyLoginError) return renderConsent(c, q, v.ok, "Samply did not accept that token. Check it, or create a new one.");
      if (err instanceof SamplyError) {
        log("login_check_failed", { status: err.status });
        return renderConsent(c, q, v.ok, `Samply could not be reached (${err.status}). Try again in a moment.`);
      }
      throw err;
    }
    const code: CodeWire = { k: "d", st: token, cc: v.ok.codeChallenge, ru: v.ok.redirectUri, exp: now() + CODE_WINDOW_SECONDS };
    const back = new URL(v.ok.redirectUri);
    back.searchParams.set("code", encryptBlob(code, cfg.keys));
    back.searchParams.set("state", v.ok.clientState);
    deleteCookie(c, LOGIN_COOKIE, LOGIN_COOKIE_ATTRS);
    return c.html(continuePage(back.toString(), clientLabel(v.ok.redirectUri)), 200, PAGE_HEADERS);
  });

  app.post("/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const raw: unknown = contentType.includes("json") ? await c.req.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await c.req.text()));
    const fields = tokenFields(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
    const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
    const oauthError = (error: string, description: string) => c.json({ error, error_description: description }, 400, noStore);

    if (fields.grant_type === "authorization_code") {
      let code: CodeWire;
      try {
        const wire = decryptBlob<Partial<CodeWire>>(fields.code, cfg.keys);
        if (wire.k !== "d" || !wire.st || !wire.cc || !wire.ru || typeof wire.exp !== "number") throw new BlobError("invalid");
        code = wire as CodeWire;
      } catch {
        return oauthError("invalid_grant", "code invalid or expired");
      }
      let client: { redirectUris: string[] };
      try {
        client = await resolveClient(cfg, fields.client_id);
      } catch {
        return oauthError("invalid_client", "unknown client_id");
      }
      if (fields.redirect_uri !== code.ru || !isRegisteredRedirectUri(client.redirectUris, code.ru) || !isAllowedRedirectUri(code.ru)) {
        return oauthError("invalid_grant", "redirect_uri mismatch");
      }
      if (!fields.code_verifier || !verifyPkce(fields.code_verifier, code.cc)) {
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      const anonId = anonymousId(code.st, cfg.userSalt);
      try {
        await cfg.usage.recordFirstLogin(anonId);
      } catch {
        log("usage_failed", { tool: "login" });
      }
      return c.json(issueTokens(cfg, code.st, anonId), 200, noStore);
    }

    if (fields.grant_type === "refresh_token") {
      try {
        return c.json(await renewTokens(cfg, fields.refresh_token), 200, noStore);
      } catch (err) {
        if (err instanceof BlobError) return oauthError("invalid_grant", "refresh token invalid");
        if (err instanceof SamplyLoginError) return oauthError("invalid_grant", "Samply no longer accepts the token; connect again");
        if (err instanceof SamplyError) return c.json({ error: "temporarily_unavailable", error_description: `Samply answered ${err.status}` }, 503, noStore);
        throw err;
      }
    }

    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  });

  return app;
}
