import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_SECONDS, issueTokens, readAccessToken, readRefreshToken, renewTokens } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { BlobError } from "../../src/crypto/blob.js";
import { SamplyLoginError } from "../../src/samply/login.js";

const cfg = testConfig();
const TOKEN = "PLAINTEXT-SAMPLY-PERSONAL-TOKEN";

describe("issueTokens", () => {
  it("issues one-hour encrypted wrappers that never show the token", () => {
    const issued = issueTokens(cfg, TOKEN, "anon1", 1000);
    expect(issued.token_type).toBe("bearer");
    expect(issued.expires_in).toBe(ACCESS_TOKEN_SECONDS);
    expect(issued.access_token).not.toContain(TOKEN);
    expect(issued.refresh_token).not.toContain(TOKEN);
    expect(issued.access_token.startsWith("v1e.")).toBe(true);
    expect(readAccessToken(cfg, issued.access_token, 1050)).toEqual({ samplyToken: TOKEN, anonId: "anon1", exp: 1000 + ACCESS_TOKEN_SECONDS });
    expect(readRefreshToken(cfg, issued.refresh_token)).toEqual({ samplyToken: TOKEN, anonId: "anon1" });
  });

  it("access tokens expire; refresh tokens do not; kinds are not interchangeable", () => {
    const issued = issueTokens(cfg, TOKEN, "anon1", 1000);
    expect(() => readAccessToken(cfg, issued.access_token, 1000 + ACCESS_TOKEN_SECONDS + 1)).toThrow(BlobError);
    expect(readRefreshToken(cfg, issued.refresh_token).samplyToken).toBe(TOKEN);
    expect(() => readRefreshToken(cfg, issued.access_token)).toThrow(BlobError);
    expect(() => readAccessToken(cfg, issued.refresh_token, 1000)).toThrow(BlobError);
  });
});

describe("renewTokens", () => {
  it("asks Samply whether the token still works on every renewal, then re-wraps it", async () => {
    const seen: string[] = [];
    const c = testConfig({
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json([]);
      },
    });
    const issued = issueTokens(c, TOKEN, "anon1", 1000);
    const renewed = await renewTokens(c, issued.refresh_token, 1010);
    expect(seen).toEqual([`Bearer ${TOKEN}`]);
    expect(readAccessToken(c, renewed.access_token, 1010)).toEqual({ samplyToken: TOKEN, anonId: "anon1", exp: 1010 + ACCESS_TOKEN_SECONDS });
    expect(readRefreshToken(c, renewed.refresh_token)).toEqual({ samplyToken: TOKEN, anonId: "anon1" });
  });

  it("refuses a token Samply has revoked", async () => {
    const c = testConfig({ fetch: async () => new Response("revoked", { status: 401 }) });
    const issued = issueTokens(c, TOKEN, "anon1", 1000);
    await expect(renewTokens(c, issued.refresh_token, 1010)).rejects.toThrow(SamplyLoginError);
  });

  it("rejects garbage", async () => {
    await expect(renewTokens(cfg, "garbage", 1)).rejects.toThrow(BlobError);
  });
});
