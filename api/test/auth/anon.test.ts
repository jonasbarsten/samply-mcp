import { describe, expect, it } from "vitest";
import { anonymousId } from "../../src/auth/anon.js";

const salt = Buffer.from("c".repeat(64), "hex");

describe("anonymousId", () => {
  it("is stable, salted and reveals nothing of the token", () => {
    const a = anonymousId("smp_SECRET-token-value", salt);
    expect(a).toBe(anonymousId("smp_SECRET-token-value", salt));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(anonymousId("smp_SECRET-token-value", Buffer.from("d".repeat(64), "hex")));
    expect(a).not.toBe(anonymousId("smp_secret-token-value", salt));
    expect(a).not.toContain("SECRET");
  });
});
