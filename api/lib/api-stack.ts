import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

// The certificate, the API Gateway custom domain and the DNS record are
// static and live in the iac stack; this stack only maps its API onto them.
export const DOMAIN = "api.samply-mcp.byjoba.com";
/**
 * False until the iac stack owns the domain (its CERTIFICATE_ARN is set, see docs/setup.md): the
 * domain exports do not exist before that, and importing them would fail the deploy. While false
 * the API answers only on its execute-api address and PUBLIC_URL is a placeholder.
 */
export const DOMAIN_ATTACHED = false;
const DOMAIN_EXPORTS = {
  name: "samply-mcp-api-domain-name",
  regionalDomainName: "samply-mcp-api-domain-regional-domain-name",
  regionalHostedZoneId: "samply-mcp-api-domain-regional-hosted-zone-id",
};
const PARAM_PREFIX = "/samply_mcp";
export const PARAM_NAMES = ["signing_key", "user_salt"];
const FUNCTION_NAME = "samply-mcp-api";
const BOUNDARY_POLICY_NAME = "samply-mcp-cfn-exec";

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { domainAttached?: boolean }) {
    super(scope, id, props);
    const domainAttached = props.domainAttached ?? DOMAIN_ATTACHED;

    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyName(this, "Boundary", BOUNDARY_POLICY_NAME),
    );

    const logGroup = new logs.LogGroup(this, "FunctionLogs", {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Owned by the iac stack (anonymous usage counters only).
    const table = dynamodb.TableV2.fromTableName(this, "UsageTable", Fn.importValue("samply-mcp-usage-table-name"));

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "samply-mcp",
      createDefaultStage: false,
      disableExecuteApiEndpoint: domainAttached,
    });

    const fn = new NodejsFunction(this, "Handler", {
      functionName: FUNCTION_NAME,
      entry: fileURLToPath(new URL("../src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      // Samply documents no concurrency limit; 10 is the abuse ceiling, and enough that a
      // client's parallel tool calls are not refused with 503.
      reservedConcurrentExecutions: 10,
      logGroup,
      // Before the domain is attached the API has no stable public name, so the OAuth metadata
      // (issuer, authorize and token URLs) points at the execute-api address.
      environment: {
        PUBLIC_URL: domainAttached ? `https://${DOMAIN}` : api.apiEndpoint,
        PARAM_PREFIX,
        USAGE_TABLE_NAME: table.tableName,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        minify: false,
        sourceMap: true,
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        // src/assets.ts (the only module allowed to read assets; it sits at the src root) reads
        // ./assets/* relative to itself. The bundle is one flat index.mjs, so the folder must sit
        // next to it. A test in api/test/assets.test.ts guards the src-root rule.
        // The widgets (src/assets/*.html) are generated and gitignored, so they are built here,
        // inside bundling, where no workflow can skip it.
        commandHooks: {
          beforeBundling: (inputDir) => [`node ${inputDir}/api/scripts/build-widget.mjs`],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [`cp -r ${inputDir}/api/src/assets ${outputDir}/assets`],
        },
      },
    });

    for (const name of PARAM_NAMES) {
      ssm.StringParameter.fromSecureStringParameterAttributes(this, `Param-${name}`, { parameterName: `${PARAM_PREFIX}/${name}` }).grantRead(fn);
    }
    table.grantReadWriteData(fn);

    const integration = new HttpLambdaIntegration("LambdaIntegration", fn);
    api.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration });
    api.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration });

    const accessLogs = new logs.LogGroup(this, "AccessLogs", {
      logGroupName: `/aws/apigateway/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Deliberately no headers and no query string: nothing here can carry a token.
    const accessLogFormat = AccessLogFormat.custom(
      JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        method: "$context.httpMethod",
        path: "$context.path",
        status: "$context.status",
        responseLength: "$context.responseLength",
        integrationError: "$context.integrationErrorMessage",
      }),
    );
    const domainName = domainAttached
      ? apigwv2.DomainName.fromDomainNameAttributes(this, "Domain", {
          name: Fn.importValue(DOMAIN_EXPORTS.name),
          regionalDomainName: Fn.importValue(DOMAIN_EXPORTS.regionalDomainName),
          regionalHostedZoneId: Fn.importValue(DOMAIN_EXPORTS.regionalHostedZoneId),
        })
      : undefined;
    new apigwv2.HttpStage(this, "Stage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      ...(domainName ? { domainMapping: { domainName } } : {}),
      throttle: { rateLimit: 20, burstLimit: 40 },
      accessLogSettings: { destination: new apigwv2.LogGroupLogDestination(accessLogs), format: accessLogFormat },
    });

    new CfnOutput(this, "ApiUrl", { value: domainAttached ? `https://${DOMAIN}` : api.apiEndpoint });
  }
}
