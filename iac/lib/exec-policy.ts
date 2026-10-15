import * as iam from "aws-cdk-lib/aws-iam";
import { QUALIFIER } from "./synthesizer.js";

export const EXEC_POLICY_NAME = "samply-mcp-cfn-exec";
export const ZONE_ID = "Z04810525CNVQNP7ALNV";
/** The API's hostname. The apex samply-mcp.byjoba.com is kept free for a site. */
export const DOMAIN = "api.samply-mcp.byjoba.com";
export const ZONE_NAME = "byjoba.com";

/**
 * The only bootstrap roles a deploy needs: deploy-role to run CloudFormation
 * and file-publishing-role to upload assets. The lookup role carries
 * account-wide ReadOnlyAccess and the stacks use no context lookups, so it
 * is deliberately not assumable.
 */
export function bootstrapRoleArns(account: string, region: string): string[] {
  return ["deploy", "file-publishing"].map((kind) => `arn:aws:iam::${account}:role/cdk-${QUALIFIER}-${kind}-role-${account}-${region}`);
}

/**
 * What CloudFormation may do when deploying samply-mcp stacks, and the
 * permissions boundary on every role those stacks create. Everything is
 * pinned to the samply-mcp-* name prefix, the byjoba.com zone, the
 * samplymcp asset bucket and the /samply_mcp/* parameters. The account's
 * GitHub OIDC provider belongs to fiken-mcp-iac and is only read here.
 */
export function execPolicyStatements(account: string, region: string): iam.PolicyStatement[] {
  const boundaryArn = `arn:aws:iam::${account}:policy/${EXEC_POLICY_NAME}`;
  return [
    new iam.PolicyStatement({
      sid: "Assets",
      actions: ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"],
      resources: [
        `arn:aws:s3:::cdk-${QUALIFIER}-assets-${account}-${region}`,
        `arn:aws:s3:::cdk-${QUALIFIER}-assets-${account}-${region}/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "Lambda",
      actions: ["lambda:*"],
      resources: [`arn:aws:lambda:${region}:${account}:function:samply-mcp-*`],
    }),
    new iam.PolicyStatement({
      sid: "Logs",
      actions: ["logs:*"],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/samply-mcp-*`,
        `arn:aws:logs:${region}:${account}:log-group:/aws/apigateway/samply-mcp-*`,
        `arn:aws:logs:${region}:${account}:log-group:/samply-mcp/*`,
      ],
    }),
    new iam.PolicyStatement({
      // API Gateway delivers HTTP API access logs through CloudWatch Logs
      // "log delivery", which is account-level plumbing with no resource
      // scoping: the documented set below must be granted on "*". It creates
      // delivery subscriptions and the Logs resource policy that lets API
      // Gateway write; it cannot read or delete log events. DescribeLogGroups
      // is also how CloudFormation resolves a log group's Arn attribute.
      sid: "LogDelivery",
      actions: [
        "logs:CreateLogDelivery",
        "logs:GetLogDelivery",
        "logs:UpdateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:DescribeResourcePolicies",
        "logs:DescribeLogGroups",
      ],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "RolesWithBoundary",
      actions: ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
      resources: [`arn:aws:iam::${account}:role/samply-mcp-*`],
      conditions: { StringEquals: { "iam:PermissionsBoundary": boundaryArn } },
    }),
    // iam:UpdateRole (description, session duration) does not carry the
    // iam:PermissionsBoundary condition key, so it lives here unconditioned.
    new iam.PolicyStatement({
      sid: "RolesRead",
      actions: [
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
      ],
      resources: [`arn:aws:iam::${account}:role/samply-mcp-*`],
    }),
    new iam.PolicyStatement({
      sid: "DenyBoundaryRemoval",
      effect: iam.Effect.DENY,
      actions: ["iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "PassRoleToLambda",
      actions: ["iam:PassRole"],
      resources: [`arn:aws:iam::${account}:role/samply-mcp-*`],
      conditions: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
    }),
    new iam.PolicyStatement({
      sid: "Policies",
      actions: [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      resources: [`arn:aws:iam::${account}:policy/samply-mcp-*`],
    }),
    new iam.PolicyStatement({
      // The provider is created by fiken-mcp-iac; the deploy role here only
      // trusts it, which needs no IAM right beyond reading it.
      sid: "GitHubOidcProviderRead",
      actions: ["iam:GetOpenIDConnectProvider"],
      resources: [`arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`],
    }),
    new iam.PolicyStatement({
      sid: "ApiGateway",
      actions: ["apigateway:*"],
      resources: [
        `arn:aws:apigateway:${region}::/apis`,
        `arn:aws:apigateway:${region}::/apis/*`,
        `arn:aws:apigateway:${region}::/domainnames`,
        `arn:aws:apigateway:${region}::/domainnames/*`,
        `arn:aws:apigateway:${region}::/tags/*`,
      ],
    }),
    new iam.PolicyStatement({
      // The certificate is requested once by hand (docs/setup.md) and imported
      // by ARN, so CloudFormation never requests, tags or deletes certificates.
      // Read-only, for the API Gateway custom domain that references it.
      sid: "CertificatesRead",
      actions: ["acm:DescribeCertificate", "acm:ListTagsForCertificate"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "DnsZone",
      actions: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets", "route53:GetHostedZone"],
      resources: [`arn:aws:route53:::hostedzone/${ZONE_ID}`],
    }),
    new iam.PolicyStatement({
      sid: "DnsRead",
      actions: ["route53:GetChange", "route53:ListHostedZones", "route53:ListHostedZonesByName"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "Dynamo",
      actions: ["dynamodb:*"],
      resources: [
        `arn:aws:dynamodb:${region}:${account}:table/samply-mcp-*`,
        `arn:aws:dynamodb::${account}:global-table/samply-mcp-*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "DynamoRead",
      actions: ["dynamodb:ListTables", "dynamodb:DescribeLimits"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "Parameters",
      actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:DescribeParameters", "ssm:GetParameterHistory"],
      resources: [
        `arn:aws:ssm:${region}:${account}:parameter/samply_mcp/*`,
        `arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/${QUALIFIER}/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "ParameterDecrypt",
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: { StringEquals: { "kms:ViaService": `ssm.${region}.amazonaws.com` } },
    }),
    new iam.PolicyStatement({
      sid: "AssumeBootstrapRoles",
      actions: ["sts:AssumeRole"],
      resources: bootstrapRoleArns(account, region),
    }),
  ];
}
