import type { Config } from "../config.js";
import { createSamplyClient, SamplyError } from "./client.js";

/** Thrown when Samply refuses the token itself (401 or 403), as opposed to failing for another reason. */
export class SamplyLoginError extends Error {
  constructor() {
    super("Samply did not accept the token");
    this.name = "SamplyLoginError";
  }
}

/** The one endpoint that is auth-only and documented: an empty account still answers 200 with `[]`. */
export const LOGIN_CHECK_PATH = "/projects";

/**
 * Checks that a personal access token works, with one `GET /projects`. The token is never stored:
 * it is sealed into the tokens we issue and comes back with every request. Throws SamplyLoginError
 * when Samply refuses it; any other failure propagates as a SamplyError for the caller to report.
 */
export async function verifySamplyToken(cfg: Config, token: string): Promise<void> {
  const client = createSamplyClient({ baseUrl: cfg.samplyBaseUrl, accessToken: token, fetch: cfg.fetch });
  try {
    await client.get(LOGIN_CHECK_PATH);
  } catch (err) {
    if (err instanceof SamplyError && (err.status === 401 || err.status === 403)) throw new SamplyLoginError();
    throw err;
  }
}

/** What a personal access token must look like before we send it anywhere: one line, printable ASCII, a sane length. */
export function isPlausibleToken(token: string): boolean {
  return token.length >= 16 && token.length <= 512 && /^[\x21-\x7e]+$/.test(token);
}
