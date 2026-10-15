import { describe, expect, it } from "vitest";
import { STACK_KEYS, deployTargets, stacksFor } from "../lib/deploy-targets.js";

describe("stacksFor", () => {
  it.each([
    ["iac/lib/iac-stack.ts", ["iac"]],
    ["iac/lib/exec-policy.ts", ["iac"]],
    ["iac/bin/iac.ts", ["iac"]],
    ["iac/package.json", ["iac"]],
    ["api/src/mcp/context.ts", ["api"]],
    ["api/lib/api-stack.ts", ["api"]],
    ["api/src/assets/icon.png", ["api"]],
    ["api/package.json", ["api"]],
    ["package.json", ["iac", "api"]],
    ["package-lock.json", ["iac", "api"]],
    ["tsconfig.base.json", ["iac", "api"]],
    [".github/workflows/deploy.yml", ["iac", "api"]],
    ["iac/test/iac-stack.test.ts", []],
    ["api/test/mcp/tools.test.ts", []],
    ["iac/lib/deploy-targets.ts", []],
    ["docs/setup.md", []],
    ["README.md", []],
    [".github/workflows/ci.yml", []],
  ])("%s -> %j", (path, expected) => {
    expect(stacksFor(path)).toEqual(expected);
  });
});

describe("deployTargets", () => {
  const none = { iac: false, api: false };

  it("lists the stack keys in deploy order", () => {
    expect(STACK_KEYS).toEqual(["iac", "api"]);
  });

  it("deploys nothing for no changes, only the api for an api change plus docs, and combines flags", () => {
    expect(deployTargets([])).toEqual(none);
    expect(deployTargets(["api/src/app.ts", "docs/setup.md", "README.md"])).toEqual({ ...none, api: true });
    expect(deployTargets(["iac/lib/iac-stack.ts", " api/src/app.ts ", ""])).toEqual({ iac: true, api: true });
  });
});
