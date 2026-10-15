import { createHmac } from "node:crypto";

/**
 * A stable pseudonym for usage counting: HMAC of the user's personal access token under our salt.
 * Samply documents no "who am I" endpoint, so the token is the only stable per-user secret we see;
 * the HMAC cannot be reversed, and a user who rotates their token becomes a new pseudonym.
 */
export function anonymousId(secret: string, salt: Buffer): string {
  return createHmac("sha256", salt).update(secret).digest("hex").slice(0, 32);
}
