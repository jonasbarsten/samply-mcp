import { Aspects, CfnOutput, CfnResource, RemovalPolicy, Stack, type IAspect, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import type { Construct, IConstruct } from "constructs";
import { DOMAIN, EXEC_POLICY_NAME, ZONE_ID, ZONE_NAME, bootstrapRoleArns, execPolicyStatements } from "./exec-policy.js";

/**
 * Requested once by hand in eu-west-1 and DNS-validated; see docs/setup.md. Undefined until then:
 * the stack then holds no domain, and the api stack maps nothing (DOMAIN_ATTACHED there). Set the
 * ARN here and flip DOMAIN_ATTACHED in api/lib/api-stack.ts in the same change.
 */
export const CERTIFICATE_ARN: string | undefined = undefined;

const PROJECT_TAG = { Key: "Project", Value: "samply-mcp" };

/**
 * Tags.of(app) only reaches constructs with a TagManager. A raw AWS::IAM::Role
 * CfnResource (as custom-resource providers make) has none, so the Project tag
 * is forced on directly. Kept although this stack creates no provider today,
 * so a future one cannot slip through untagged.
 */
class TagUntaggableRoles implements IAspect {
  visit(node: IConstruct): void {
    if (CfnResource.isCfnResource(node) && node.cfnResourceType === "AWS::IAM::Role" && !(node instanceof iam.CfnRole)) {
      node.addPropertyOverride("Tags", [PROJECT_TAG]);
    }
  }
}

const GITHUB_REPO = "jonasbarsten/samply-mcp";
// GitHub's immutable subject claim: owner and repo carry their numeric ids,
// so a rename or a re-created repo with the same name cannot assume the role.
// Read from `gh api repos/jonasbarsten/samply-mcp/actions/oidc/customization/sub`
// after turning on "use immutable subject" there (docs/setup.md).
export const GITHUB_SUBJECT_PREFIX = "repo:jonasbarsten@6729295/samply-mcp@1421261233";
const GITHUB_ENVIRONMENT = "production";

export class IacStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { certificateArn?: string }) {
    super(scope, id, props);
    const certificateArn = "certificateArn" in props ? props.certificateArn : CERTIFICATE_ARN;

    // Scoped CloudFormation execution policy, also the permissions boundary
    // on every role samply-mcp stacks create (this stack included).
    const execPolicy = new iam.ManagedPolicy(this, "ExecPolicy", {
      managedPolicyName: EXEC_POLICY_NAME,
      description: "What CloudFormation may do for samply-mcp stacks; boundary for their roles",
      statements: execPolicyStatements(this.account, this.region),
    });
    iam.PermissionsBoundary.of(this).apply(execPolicy);
    Aspects.of(this).add(new TagUntaggableRoles());

    const table = new dynamodb.TableV2(this, "UsageTable", {
      tableName: "samply-mcp-usage",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // An account holds one OIDC provider per issuer. fiken-mcp-iac created the
    // GitHub one in the byjoba account; this stack, like byjoba-iac, only references it.
    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubOidc",
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: "samply-mcp-github-deploy",
      description: `Assumed by GitHub Actions in the ${GITHUB_ENVIRONMENT} environment of ${GITHUB_REPO}`,
      assumedBy: new iam.OpenIdConnectPrincipal(githubProvider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `${GITHUB_SUBJECT_PREFIX}:environment:${GITHUB_ENVIRONMENT}`,
        },
      }),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: bootstrapRoleArns(this.account, this.region),
      }),
    );

    new CfnOutput(this, "UsageTableName", { value: table.tableName, exportName: "samply-mcp-usage-table-name" });
    new CfnOutput(this, "UsageTableArn", { value: table.tableArn, exportName: "samply-mcp-usage-table-arn" });
    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "ExecPolicyArn", { value: execPolicy.managedPolicyArn });

    if (!certificateArn) return;

    // The public name is static infrastructure: the hand-requested certificate,
    // the API Gateway custom domain and the alias record. The api stack only
    // maps its HTTP API onto the domain.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: ZONE_ID, zoneName: ZONE_NAME });
    const certificate = acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn);
    const domainName = new apigwv2.DomainName(this, "Domain", { domainName: DOMAIN, certificate });
    // CloudFormation creates independent resources in parallel; make the domain
    // wait for the execution-policy update in the same deploy so a new
    // permission it relies on is in place before it is used.
    domainName.node.addDependency(execPolicy);
    new route53.ARecord(this, "AliasRecord", {
      zone,
      recordName: DOMAIN.slice(0, -(ZONE_NAME.length + 1)),
      target: route53.RecordTarget.fromAlias(new targets.ApiGatewayv2DomainProperties(domainName.regionalDomainName, domainName.regionalHostedZoneId)),
    });

    new CfnOutput(this, "ApiDomainName", { value: domainName.name, exportName: "samply-mcp-api-domain-name" });
    new CfnOutput(this, "ApiDomainRegionalDomainName", { value: domainName.regionalDomainName, exportName: "samply-mcp-api-domain-regional-domain-name" });
    new CfnOutput(this, "ApiDomainRegionalHostedZoneId", { value: domainName.regionalHostedZoneId, exportName: "samply-mcp-api-domain-regional-hosted-zone-id" });
  }
}
