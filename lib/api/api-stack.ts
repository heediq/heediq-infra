import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { WorkloadEnv, DOMAINS, ACCOUNTS, SHARED_SERVICES, COMPUTE, logRetentionFor } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';
import { Route53AliasRecord } from '../shared/route53-alias-record';

export interface ApiStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const apiDomain = DOMAINS.api[props.workloadEnv];

    // ── CloudWatch log group (D-093) ──────────────────────────────────────────
    // Explicit retention — the CDK default (no LogGroup/logRetention) is "Never Expire".
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/aws/lambda/heediq-api',
      retention: logRetentionFor(props.workloadEnv),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── API Lambda — Hono REST API (D-034) ────────────────────────────────────
    // Actual implementation deployed by heediq-api CI. This construct owns the IAM role,
    // env vars, and API Gateway wiring. Placeholder code below is replaced on deploy.
    const apiFn = new lambda.Function(this, 'ApiFn', {
      functionName: 'heediq-api',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      // Placeholder — real code deployed by heediq-api CI (D-043, D-050)
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, body: "ok" });',
      ),
      memorySize: COMPUTE.lambda.api.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.api.timeoutSecs),
      tracing: lambda.Tracing.ACTIVE, // D-085 — X-Ray active tracing, no separate observability tool
      logGroup: apiLogGroup, // D-093 — explicit retention, no unbounded log storage
      environment: {
        SOURCES_TABLE_NAME:        props.foundation.sourcesTable.tableName,
        ORGS_TABLE_NAME:           props.foundation.orgsTable.tableName,
        USERS_TABLE_NAME:          props.foundation.usersTable.tableName,
        JOBS_TABLE_NAME:           props.foundation.jobsTable.tableName,
        WS_CONNECTIONS_TABLE_NAME: props.foundation.wsConnectionsTable.tableName,
        USER_AUTH_METHODS_TABLE_NAME: props.foundation.userAuthMethodsTable.tableName,
        AUTH_AUDIT_LOG_TABLE_NAME:    props.foundation.authAuditLogTable.tableName,
        RATE_LIMITS_TABLE_NAME:    props.foundation.rateLimitsTable.tableName,
        COGNITO_IDENTITIES_TABLE_NAME: props.foundation.cognitoIdentitiesTable.tableName,
        // RBAC & audit trail tables (D-102 Phase 2) — schema-only since Phase 1 (#48); this is
        // their first real consumer.
        ROLES_TABLE_NAME:          props.foundation.rolesTable.tableName,
        GROUPS_TABLE_NAME:         props.foundation.groupsTable.tableName,
        ROLE_ASSIGNMENTS_TABLE_NAME: props.foundation.roleAssignmentsTable.tableName,
        AUDIT_LOG_TABLE_NAME:      props.foundation.auditLogTable.tableName,
        AUDIO_BUCKET_NAME:         props.foundation.audioUploadsBucket.bucketName,
        TRANSCRIPTION_QUEUE_URL:   props.foundation.transcriptionQueue.queueUrl,
        COGNITO_USER_POOL_ID:      props.foundation.userPool.userPoolId,
        COGNITO_CLIENT_ID:         props.foundation.userPoolClient.userPoolClientId,
        // Summarization queue — direct path for non-audio sources (D-065, D-026)
        SUMMARIZATION_QUEUE_URL:   `https://sqs.${this.region}.amazonaws.com/${this.account}/heediq-summarization`,
      },
    });

    // ── IAM grants — least privilege (D-034) ─────────────────────────────────
    // DynamoDB — all five tables the API reads/writes
    props.foundation.sourcesTable.grantReadWriteData(apiFn);
    props.foundation.orgsTable.grantReadWriteData(apiFn);
    props.foundation.usersTable.grantReadWriteData(apiFn);
    props.foundation.jobsTable.grantReadWriteData(apiFn);
    props.foundation.wsConnectionsTable.grantReadData(apiFn);
    props.foundation.userAuthMethodsTable.grantReadWriteData(apiFn);
    props.foundation.authAuditLogTable.grantWriteData(apiFn);
    props.foundation.rateLimitsTable.grantReadWriteData(apiFn);
    props.foundation.cognitoIdentitiesTable.grantReadWriteData(apiFn);
    // RBAC & audit trail (D-102 Phase 2) — roles/groups/role-assignments are read-write; the
    // audit log is write-only, enforcing "no delete/update code path" (D-102) at the IAM layer
    // too, not just convention (mirrors authAuditLogTable's write-only grant above).
    props.foundation.rolesTable.grantReadWriteData(apiFn);
    props.foundation.groupsTable.grantReadWriteData(apiFn);
    props.foundation.roleAssignmentsTable.grantReadWriteData(apiFn);
    props.foundation.auditLogTable.grantWriteData(apiFn);

    // S3 — presigned URL creation + audio read
    props.foundation.audioUploadsBucket.grantReadWrite(apiFn);

    // SQS — enqueue transcription jobs (D-023, D-060)
    props.foundation.transcriptionQueue.grantSendMessages(apiFn);

    // Secrets Manager — Stripe + Recall.ai keys via Lambda Extension at cold start (D-038)
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/heediq/api/*`,
        ],
      }),
    );

    // SES cross-account sending — assume heediq-ses-email-sending in shared-services (D-058)
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${ACCOUNTS.sharedServices}:role/heediq-ses-email-sending`,
        ],
      }),
    );

    // SQS — enqueue to summarization queue for non-audio sources (D-065)
    // Text files, PDFs, emails, Excel etc. skip transcription and go direct to summarization.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:heediq-summarization`,
        ],
      }),
    );

    // Cognito Admin API — cross-provider account linking (D-078, D-087). SignUp/
    // ConfirmSignUp/ResendConfirmationCode drive the request-otp/confirm endpoints (D-087,
    // reusing Cognito's own verification-code delivery instead of custom OTP+SES). ListUsers
    // resolves the existing federated identity to link; AdminSetUserPassword/
    // AdminLinkProviderForUser attach the password and link the provider — never create a new
    // Cognito user themselves (SignUp does that part). AdminDeleteUser (D-096) removes a native
    // user stuck CONFIRMED-but-never-linked (abandoned between the code and password screens),
    // so request-otp can self-heal by re-running SignUp. Scoped to this pool's ARN only.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminLinkProviderForUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:SignUp',
          'cognito-idp:ConfirmSignUp',
          'cognito-idp:ResendConfirmationCode',
          'cognito-idp:ListUsers',
        ],
        resources: [props.foundation.userPool.userPoolArn],
      }),
    );

    // ── API Gateway HTTP API (D-034, D-041, D-042) ────────────────────────────
    const httpApi = new apigatewayv2.CfnApi(this, 'HttpApi', {
      name: 'heediq-api',
      protocolType: 'HTTP',
      corsConfiguration: {
        allowOrigins: [
          `https://${DOMAINS.web[props.workloadEnv]}`,
          // localhost for dev convenience (not deployed to staging/prod)
          ...(props.workloadEnv === 'dev' ? ['http://localhost:5173'] : []),
        ],
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowCredentials: true,
        maxAge: 86400,
      },
    });

    // API Gateway permission to invoke the Lambda
    apiFn.addPermission('ApiGwInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.ref}/*`,
    });

    const integration = new apigatewayv2.CfnIntegration(this, 'LambdaIntegration', {
      apiId: httpApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${apiFn.functionArn}/invocations`,
      payloadFormatVersion: '2.0',
    });

    // Catch-all route — Hono handles /api/v1/ prefix and all routing internally (D-034, D-042)
    new apigatewayv2.CfnRoute(this, 'ProxyRoute', {
      apiId: httpApi.ref,
      routeKey: 'ANY /{proxy+}',
      target: `integrations/${integration.ref}`,
    });

    // Stage-level throttling (D-097) — the whole API is one catch-all proxy route, so this
    // applies globally rather than per logical endpoint; still stops raw request floods
    // before Lambda even runs. Cheap (no extra charge), so on in every environment.
    const stage = new apigatewayv2.CfnStage(this, 'Stage', {
      apiId: httpApi.ref,
      stageName: '$default',
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit: 50,
        throttlingRateLimit: 20,
      },
    });

    // ── WAF rate-based rule (D-097, deferred activation per D-098) ────────────
    // Written now so enabling it later is a one-line config flip, not new code, but not
    // deployed active anywhere yet — WAF carries a real fixed monthly cost that isn't
    // justified before there's meaningful unauthenticated traffic to defend against.
    // Flip ENABLE_WAF[workloadEnv] to true (prod only, per D-097) before a marketing push.
    const ENABLE_WAF: Record<WorkloadEnv, boolean> = {
      dev: false,
      staging: false,
      prod: false,
    };
    if (ENABLE_WAF[props.workloadEnv]) {
      const rateLimitWebAcl = new wafv2.CfnWebACL(this, 'ApiRateLimitWebAcl', {
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'heediq-api-rate-limit',
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'RateLimitPerIp',
            priority: 0,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: 500, // requests per 5-minute window per IP
                aggregateKeyType: 'IP',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'heediq-api-rate-limit-per-ip',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });

      new wafv2.CfnWebACLAssociation(this, 'ApiRateLimitWebAclAssociation', {
        resourceArn: `arn:aws:apigateway:${this.region}::/apis/${httpApi.ref}/stages/${stage.ref}`,
        webAclArn: rateLimitWebAcl.attrArn,
      });
    }

    // ── Custom domain (D-052, D-053, D-063) ──────────────────────────────────
    // Cert comes from FoundationStack.wildcardCert — same workload account, same region.
    const domainName = new apigatewayv2.CfnDomainName(this, 'DomainName', {
      domainName: apiDomain,
      domainNameConfigurations: [
        {
          certificateArn: props.foundation.wildcardCert.certificateArn,
          endpointType: 'REGIONAL',
        },
      ],
    });

    new apigatewayv2.CfnApiMapping(this, 'ApiMapping', {
      apiId: httpApi.ref,
      domainName: domainName.ref,
      stage: stage.ref,
    });

    // Route 53 A-alias record — api-{env}.heediq.com → API Gateway regional endpoint (D-064)
    new Route53AliasRecord(this, 'ApiAliasRecord', {
      recordName: apiDomain,
      targetDnsName: domainName.attrRegionalDomainName,
      targetHostedZoneId: domainName.attrRegionalHostedZoneId,
      hostedZoneId: SHARED_SERVICES.hostedZoneId,
      dnsManagerRoleArn: `arn:aws:iam::${ACCOUNTS.sharedServices}:role/heediq-route53-dns-manager`,
    });

    // ── SSM params (D-038) ────────────────────────────────────────────────────

    new ssm.StringParameter(this, 'ApiEndpointUrlParam', {
      parameterName: '/heediq/api/endpoint-url',
      stringValue: `https://${apiDomain}`,
      description: 'REST API endpoint URL (https://)',
    });

    new ssm.StringParameter(this, 'ApiRegionalDomainParam', {
      parameterName: '/heediq/api/regional-domain-name',
      stringValue: domainName.attrRegionalDomainName,
      description: 'API Gateway REST regional domain name (Route 53 alias target)',
    });
  }
}
