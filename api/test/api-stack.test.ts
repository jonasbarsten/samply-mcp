import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { App, Tags } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack, DOMAIN_ATTACHED } from "../lib/api-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

// The first synth bundles the Lambda with esbuild; on a loaded machine or CI runner it exceeds vitest's 5 s default.
const STACK_TEST_TIMEOUT_MS = 120_000;
const env = { account: "209479295726", region: "eu-west-1" };

function synth(domainAttached = true) {
  const app = new App();
  const stack = new ApiStack(app, "samply-mcp-api", { env, synthesizer: synthesizer(), domainAttached });
  return Template.fromStack(stack);
}

describe("ApiStack", () => {
  it("creates the function with reserved concurrency 10 on Node 24 arm64 and 30-day log groups", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "samply-mcp-api",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      ReservedConcurrentExecutions: 10,
      Environment: {
        Variables: {
          PUBLIC_URL: "https://api.samply-mcp.byjoba.com",
          PARAM_PREFIX: "/samply_mcp",
          USAGE_TABLE_NAME: { "Fn::ImportValue": "samply-mcp-usage-table-name" },
        },
      },
    });
    t.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/samply-mcp-api", RetentionInDays: 30 });
    t.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/apigateway/samply-mcp-api", RetentionInDays: 30 });
  });

  it("applies the permissions boundary to every role", () => {
    const roles = synth().findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const role of Object.values(roles)) expect(role.Properties.PermissionsBoundary).toBeDefined();
  });

  it("grants read on exactly the two parameters, and read/write on the imported usage table", () => {
    const policies = synth().findResources("AWS::IAM::Policy");
    expect(Object.keys(policies)).toHaveLength(1);
    const statements = Object.values(policies)[0]!.Properties.PolicyDocument.Statement as Array<{ Action: string[]; Effect: string; Resource: unknown }>;
    const ssm = statements.filter((s) => Array.isArray(s.Action) && s.Action[0] === "ssm:DescribeParameters") as Array<{ Resource: { "Fn::Join": [string, unknown[]] } }>;
    expect(ssm).toHaveLength(2);
    const suffixes = ssm.map((s) => s.Resource["Fn::Join"][1] as string[]).map((parts) => parts[parts.length - 1]);
    expect(suffixes.sort()).toEqual([":ssm:eu-west-1:209479295726:parameter/samply_mcp/signing_key", ":ssm:eu-west-1:209479295726:parameter/samply_mcp/user_salt"]);
    const table = statements.find((s) => Array.isArray(s.Action) && ["dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:GetItem"].every((a) => s.Action.includes(a)));
    expect(table).toBeDefined();
    expect(JSON.stringify(table!.Resource)).toContain("samply-mcp-usage-table-name");
  });

  it("throttles the stage and writes access logs without headers", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: { Format: Match.stringLikeRegexp("requestId") },
    });
    const stage = Object.values(t.findResources("AWS::ApiGatewayV2::Stage"))[0]!;
    expect(String(stage.Properties.AccessLogSettings.Format)).not.toMatch(/authorization|header/i);
  });

  it("maps the api onto the domain exported by the iac stack and owns no certificate or DNS", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::ApiMapping", { DomainName: { "Fn::ImportValue": "samply-mcp-api-domain-name" }, Stage: "$default" });
    t.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    t.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /{proxy+}" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { DisableExecuteApiEndpoint: true });
    expect(Object.keys(t.findOutputs("ApiUrl")).length).toBe(1);
  });

  it("before the domain is attached, maps nothing, keeps the execute-api address and points PUBLIC_URL at it", () => {
    const t = synth(false);
    t.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 0);
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { DisableExecuteApiEndpoint: false });
    const fn = Object.values(t.findResources("AWS::Lambda::Function"))[0]!;
    expect(fn.Properties.Environment.Variables.PUBLIC_URL).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^HttpApi/), "ApiEndpoint"] });
    expect(JSON.stringify(t.toJSON())).not.toContain("samply-mcp-api-domain-name");
    // The committed flag: flip it together with CERTIFICATE_ARN in iac (docs/setup.md).
    expect(typeof DOMAIN_ATTACHED).toBe("boolean");
  });

  it("bundles the generated widgets and the icon next to the handler, without any npm hook", () => {
    const app = new App();
    new ApiStack(app, "samply-mcp-api", { env, synthesizer: synthesizer(), domainAttached: true });
    const assembly = app.synth();
    const assetDirs = readdirSync(assembly.directory).filter((name) => name.startsWith("asset."));
    const withWidget = assetDirs.filter((dir) => existsSync(join(assembly.directory, dir, "assets", "choice.html")));
    expect(withWidget).toHaveLength(1);
    const dir = join(assembly.directory, withWidget[0]!);
    expect(existsSync(join(dir, "index.mjs"))).toBe(true);
    expect(existsSync(join(dir, "assets", "icon.png"))).toBe(true);
    expect(existsSync(join(dir, "assets", "table.html"))).toBe(true);
    expect(statSync(join(dir, "assets", "choice.html")).size).toBeGreaterThan(100_000);
  });

  it("tags the function with Project=samply-mcp", () => {
    const app = new App();
    const stack = new ApiStack(app, "samply-mcp-api", { env, synthesizer: synthesizer(), domainAttached: true });
    Tags.of(app).add("Project", "samply-mcp");
    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::Function", { Tags: Match.arrayWith([{ Key: "Project", Value: "samply-mcp" }]) });
  });
}, STACK_TEST_TIMEOUT_MS);
