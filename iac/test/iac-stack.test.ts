import { App, Tags } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CERTIFICATE_ARN, GITHUB_SUBJECT_PREFIX, IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

// The first synth in a file is the slow one; on a loaded machine or CI runner it exceeds vitest's 5 s default.
const STACK_TEST_TIMEOUT_MS = 60_000;
const env = { account: "209479295726", region: "eu-west-1" };
const CERT = "arn:aws:acm:eu-west-1:209479295726:certificate/00000000-0000-4000-8000-000000000000";

/** With the test certificate by default; `{}` leaves the committed CERTIFICATE_ARN in charge. */
function synth(props: { certificateArn?: string } = { certificateArn: CERT }) {
  const app = new App();
  const stack = new IacStack(app, "samply-mcp-iac", { env, synthesizer: synthesizer(), ...props });
  return Template.fromStack(stack);
}

describe("IacStack", () => {
  it("creates the usage table with PK/SK, on-demand billing and retain", () => {
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: "samply-mcp-usage",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    });
    t.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("references the account's GitHub OIDC provider instead of creating a second one", () => {
    const t = synth();
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    t.resourceCountIs("AWS::IAM::OIDCProvider", 0);
    t.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "samply-mcp-github-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRoleWithWebIdentity",
            Effect: "Allow",
            Principal: { Federated: "arn:aws:iam::209479295726:oidc-provider/token.actions.githubusercontent.com" },
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": "repo:jonasbarsten@6729295/samply-mcp@1421261233:environment:production",
              },
            },
          },
        ],
      },
    });
    expect(GITHUB_SUBJECT_PREFIX).toBe("repo:jonasbarsten@6729295/samply-mcp@1421261233");
  });

  it("lets the deploy role assume only the samplymcp deploy and file-publishing bootstrap roles", () => {
    const t = synth();
    const [policy] = Object.values(t.findResources("AWS::IAM::Policy"));
    expect(policy!.Properties.PolicyDocument.Statement).toEqual([
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Resource: [
          "arn:aws:iam::209479295726:role/cdk-samplymcp-deploy-role-209479295726-eu-west-1",
          "arn:aws:iam::209479295726:role/cdk-samplymcp-file-publishing-role-209479295726-eu-west-1",
        ],
      },
    ]);
  });

  it("never allows assuming the lookup role or a wildcard of bootstrap roles", () => {
    const t = synth();
    const policies = { ...t.findResources("AWS::IAM::Policy"), ...t.findResources("AWS::IAM::ManagedPolicy") };
    let assumeStatements = 0;
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement as Array<{ Effect: string; Action: string | string[]; Resource?: string | string[] }>) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (statement.Effect !== "Allow" || !actions.includes("sts:AssumeRole")) continue;
        assumeStatements++;
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        for (const resource of resources) {
          expect(resource).not.toContain("lookup-role");
          expect(resource).toMatch(/^arn:aws:iam::209479295726:role\/cdk-samplymcp-(deploy|file-publishing)-role-209479295726-eu-west-1$/);
        }
      }
    }
    expect(assumeStatements).toBe(2);
  });

  it("creates the scoped execution policy, pinned to samply-mcp names, and uses it as the boundary on every role", () => {
    const t = synth();
    // arrayWith matches in order, so each statement is checked on its own.
    const expected = [
      Match.objectLike({
        Action: Match.arrayWith(["iam:CreateRole", "iam:PutRolePolicy"]),
        Resource: "arn:aws:iam::209479295726:role/samply-mcp-*",
        Condition: { StringEquals: { "iam:PermissionsBoundary": "arn:aws:iam::209479295726:policy/samply-mcp-cfn-exec" } },
      }),
      { Sid: "DenyBoundaryRemoval", Effect: "Deny", Action: ["iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"], Resource: "*" },
      Match.objectLike({ Sid: "Parameters", Resource: Match.arrayWith(["arn:aws:ssm:eu-west-1:209479295726:parameter/samply_mcp/*", "arn:aws:ssm:eu-west-1:209479295726:parameter/cdk-bootstrap/samplymcp/*"]) }),
      Match.objectLike({ Sid: "Lambda", Resource: "arn:aws:lambda:eu-west-1:209479295726:function:samply-mcp-*" }),
      Match.objectLike({ Sid: "Dynamo", Resource: Match.arrayWith(["arn:aws:dynamodb:eu-west-1:209479295726:table/samply-mcp-*"]) }),
      Match.objectLike({ Sid: "GitHubOidcProviderRead", Action: "iam:GetOpenIDConnectProvider" }),
    ];
    for (const statement of expected) {
      t.hasResourceProperties("AWS::IAM::ManagedPolicy", { ManagedPolicyName: "samply-mcp-cfn-exec", PolicyDocument: { Statement: Match.arrayWith([statement]) } });
    }
    const roles = t.findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const role of Object.values(roles)) expect(role.Properties.PermissionsBoundary).toBeDefined();
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("fiken");
    expect(json).not.toContain("CreateOpenIDConnectProvider");
  });

  it("never grants an unconditioned wildcard resource except known read-only or unscoped actions", () => {
    const t = synth();
    for (const policy of Object.values(t.findResources("AWS::IAM::ManagedPolicy"))) {
      for (const statement of policy.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Effect: string; Resource?: string | string[]; Condition?: unknown }>) {
        if (statement.Effect === "Deny") continue;
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        if (!resources.includes("*")) continue;
        const known = statement.Sid !== undefined && ["DnsRead", "DynamoRead", "CertificatesRead", "LogDelivery"].includes(statement.Sid);
        expect(statement.Condition !== undefined || known, statement.Sid).toBe(true);
      }
    }
  });

  it("with a certificate, owns the custom domain and alias record for api.samply-mcp.byjoba.com and exports the domain", () => {
    const t = synth();
    t.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    t.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainName: "api.samply-mcp.byjoba.com",
      DomainNameConfigurations: [Match.objectLike({ CertificateArn: CERT })],
    });
    t.hasResourceProperties("AWS::Route53::RecordSet", { Name: "api.samply-mcp.byjoba.com.", Type: "A", HostedZoneId: "Z04810525CNVQNP7ALNV" });
    t.hasOutput("ApiDomainName", { Export: { Name: "samply-mcp-api-domain-name" } });
    t.hasOutput("ApiDomainRegionalDomainName", { Export: { Name: "samply-mcp-api-domain-regional-domain-name" } });
    t.hasOutput("ApiDomainRegionalHostedZoneId", { Export: { Name: "samply-mcp-api-domain-regional-hosted-zone-id" } });
  });

  it("without a certificate, holds the table, the policy and the role but no domain", () => {
    const t = synth({});
    t.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
    t.hasOutput("UsageTableName", { Export: { Name: "samply-mcp-usage-table-name" } });
    t.hasOutput("DeployRoleArn", {});
    t.hasOutput("ExecPolicyArn", {});
    expect(Object.keys(t.findOutputs("ApiDomainName"))).toHaveLength(0);
    // The committed value: undefined until the certificate exists (docs/setup.md).
    expect(CERTIFICATE_ARN === undefined || /^arn:aws:acm:eu-west-1:209479295726:certificate\/[0-9a-f-]{36}$/.test(CERTIFICATE_ARN)).toBe(true);
  });

  it("tags every taggable resource with Project=samply-mcp", () => {
    const app = new App();
    const stack = new IacStack(app, "samply-mcp-iac", { env, synthesizer: synthesizer(), certificateArn: CERT });
    Tags.of(app).add("Project", "samply-mcp");
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      Replicas: Match.arrayWith([Match.objectLike({ Tags: Match.arrayWith([{ Key: "Project", Value: "samply-mcp" }]) })]),
    });
    for (const role of Object.values(t.findResources("AWS::IAM::Role"))) {
      expect(role.Properties.Tags).toEqual(expect.arrayContaining([{ Key: "Project", Value: "samply-mcp" }]));
    }
  });
}, STACK_TEST_TIMEOUT_MS);
