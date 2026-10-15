import type { Config } from "../config.js";
import { BlobError, decryptBlob, encryptBlob } from "../crypto/blob.js";
import { verifySamplyToken } from "../samply/login.js";

export const ACCESS_TOKEN_SECONDS = 3600;

export interface AccessClaims { samplyToken: string; anonId: string; exp: number }
export interface RefreshClaims { samplyToken: string; anonId: string }
export interface IssuedTokens { access_token: string; refresh_token: string; token_type: "bearer"; expires_in: number }

interface AccessWire { k: "a"; t: string; u: string; exp: number }
interface RefreshWire { k: "r"; t: string; u: string }

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Both tokens are encrypted wrappers of the user's Samply personal access token plus the anonymous id.
 * The access token lives an hour, so a leaked one dies soon; the refresh token is what the client keeps.
 */
export function issueTokens(cfg: Config, samplyToken: string, anonId: string, now = nowSeconds()): IssuedTokens {
  const access: AccessWire = { k: "a", t: samplyToken, u: anonId, exp: now + ACCESS_TOKEN_SECONDS };
  const refresh: RefreshWire = { k: "r", t: samplyToken, u: anonId };
  return {
    access_token: encryptBlob(access, cfg.keys),
    refresh_token: encryptBlob(refresh, cfg.keys),
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
  };
}

export function readAccessToken(cfg: Config, token: string, now = nowSeconds()): AccessClaims {
  const wire = decryptBlob<Partial<AccessWire>>(token, cfg.keys, now);
  if (wire.k !== "a" || !wire.t || !wire.u || typeof wire.exp !== "number") throw new BlobError("invalid");
  return { samplyToken: wire.t, anonId: wire.u, exp: wire.exp };
}

export function readRefreshToken(cfg: Config, token: string): RefreshClaims {
  const wire = decryptBlob<Partial<RefreshWire>>(token, cfg.keys);
  if (wire.k !== "r" || !wire.t || !wire.u) throw new BlobError("invalid");
  return { samplyToken: wire.t, anonId: wire.u };
}

/**
 * Personal access tokens do not expire, so a renewal re-wraps the same token. It asks Samply whether the
 * token still works first, so a token revoked at samply.app/preferences/api stops working here within the
 * hour (SamplyLoginError), instead of living on inside our wrapper.
 */
export async function renewTokens(cfg: Config, refreshToken: string, now = nowSeconds()): Promise<IssuedTokens> {
  const claims = readRefreshToken(cfg, refreshToken);
  await verifySamplyToken(cfg, claims.samplyToken);
  return issueTokens(cfg, claims.samplyToken, claims.anonId, now);
}
