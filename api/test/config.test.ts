import { describe, expect, it } from "vitest";
import { loadConfig, testConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads env and Parameter Store", async () => {
    const asked: string[][] = [];
    const ssm = {
      async getParameters(names: string[]) {
        asked.push(names);
        return { "/samply_mcp/signing_key": `k1:${"a".repeat(64)}`, "/samply_mcp/user_salt": "b".repeat(64) };
      },
    };
    const cfg = await loadConfig({ env: { PUBLIC_URL: "https://x.test/", USAGE_TABLE_NAME: "usage" }, ssm });
    expect(cfg.publicUrl).toBe("https://x.test");
    expect(cfg.keys.active).toBe("k1");
    expect(cfg.userSalt.length).toBe(32);
    expect(cfg.samplyBaseUrl).toBe("https://samply.app/api/v0");
    expect(cfg.samplyTokenPageUrl).toBe("https://samply.app/preferences/api");
    expect(asked[0]).toEqual(["/samply_mcp/signing_key", "/samply_mcp/user_salt"]);
    expect(typeof cfg.usage.recordCall).toBe("function");
  });

  it("fails on missing PUBLIC_URL or missing parameters", async () => {
    const ssm = { async getParameters() { return {}; } };
    await expect(loadConfig({ env: {}, ssm })).rejects.toThrow(/PUBLIC_URL/);
    await expect(loadConfig({ env: { PUBLIC_URL: "https://x.test" }, ssm })).rejects.toThrow(/USAGE_TABLE_NAME/);
    await expect(loadConfig({ env: { PUBLIC_URL: "https://x.test", USAGE_TABLE_NAME: "usage" }, ssm })).rejects.toThrow(/signing_key/);
  });

  it("testConfig gives usable keys and an empty usage store", async () => {
    const cfg = testConfig();
    expect(cfg.keys.keys.size).toBe(1);
    expect(cfg.publicUrl).toBe("https://samply-mcp.test");
    await expect(cfg.usage.globalStats()).resolves.toEqual({ totalUsers: 0, months: [] });
  });
});
