import { describe, expect, it } from "vitest";
import { testConfig } from "../../src/config.js";
import { SamplyError } from "../../src/samply/client.js";
import { SamplyLoginError, isPlausibleToken, verifySamplyToken } from "../../src/samply/login.js";

describe("verifySamplyToken", () => {
  it("accepts a token that lists projects, with that token", async () => {
    let auth = "";
    const cfg = testConfig({ fetch: async (input, init) => { auth = new Headers(init?.headers).get("authorization") ?? ""; return String(input).endsWith("/projects") ? Response.json([]) : new Response("", { status: 500 }); } });
    await expect(verifySamplyToken(cfg, "smp_abcdefghijklmnop")).resolves.toBeUndefined();
    expect(auth).toBe("Bearer smp_abcdefghijklmnop");
  });

  it("throws SamplyLoginError on 401 or 403, and the SamplyError otherwise", async () => {
    for (const status of [401, 403]) {
      await expect(verifySamplyToken(testConfig({ fetch: async () => new Response("no", { status }) }), "t".repeat(20))).rejects.toThrow(SamplyLoginError);
    }
    await expect(verifySamplyToken(testConfig({ fetch: async () => new Response("down", { status: 503 }) }), "t".repeat(20))).rejects.toThrow(SamplyError);
  });
});

describe("isPlausibleToken", () => {
  it("takes one printable line of a sane length", () => {
    expect(isPlausibleToken("smp_abcdefghijklmnop")).toBe(true);
    expect(isPlausibleToken("x".repeat(512))).toBe(true);
    expect(isPlausibleToken("short")).toBe(false);
    expect(isPlausibleToken("x".repeat(513))).toBe(false);
    expect(isPlausibleToken("has a space in it yes")).toBe(false);
    expect(isPlausibleToken("has\nnewline-in-it-yes")).toBe(false);
    expect(isPlausibleToken("")).toBe(false);
  });
});
