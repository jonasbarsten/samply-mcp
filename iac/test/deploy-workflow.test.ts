import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");

describe("deploy.yml", () => {
  it("gates each deploy step on its own flag, iac before api", () => {
    const steps = [...workflow.matchAll(/- if: needs\.changes\.outputs\.(\w+) == 'true'\s*\n\s*run: npx cdk deploy (samply-mcp-\w+) /g)].map((m) => [m[1], m[2]]);
    expect(steps).toEqual([
      ["iac", "samply-mcp-iac"],
      ["api", "samply-mcp-api"],
    ]);
  });

  it("sets both flags when there is no successful deploy to compare with", () => {
    expect(workflow).toContain("printf 'iac=true\\napi=true\\n'");
  });

  it("asks for production approval only when something will deploy", () => {
    expect(workflow).toContain("if: needs.changes.outputs.iac == 'true' || needs.changes.outputs.api == 'true'");
    expect(workflow).toMatch(/environment: production/);
  });

  it("diffs against the last successful deploy, not the previous commit, and fails on a piped error", () => {
    expect(workflow).toContain("--status success");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("node iac/lib/deploy-targets.ts");
    expect(workflow).not.toContain("HEAD~1");
    expect(workflow).toMatch(/- id: targets\s*\n\s*shell: bash\n/);
  });

  it("pins actions to commit SHAs and never references fiken", () => {
    for (const uses of workflow.matchAll(/uses: ([^\n]+)/g)) expect(uses[1]).toMatch(/@[0-9a-f]{40} # v/);
    expect(workflow).not.toContain("fiken");
  });
});
