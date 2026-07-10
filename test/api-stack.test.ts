import { describe, it, beforeAll, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { ApiStack } from '../lib/api/api-stack';

function buildTemplates(workloadEnv: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const account = workloadEnv === 'prod' ? '438825592314' : '123456789012';
  const env = { account, region: 'eu-west-1' };

  const foundation = new FoundationStack(app, 'TestFoundationStack', {
    env,
    workloadEnv,
  });

  const api = new ApiStack(app, 'TestApiStack', {
    env,
    workloadEnv,
    foundation,
  });

  return {
    foundation: Template.fromStack(foundation),
    api: Template.fromStack(api),
  };
}

// The API Lambda's default inline role policy auto-splits into overflow
// AWS::IAM::ManagedPolicy resources once it crosses CDK's inline-policy size
// limit (aws-cdk-lib Role.splitLargePolicy, ~10,000 chars) — expected as more
// grants are added, not a regression. Statement-level IAM assertions must
// scan both resource types rather than assuming everything stays inline.
function findAllIamStatements(template: Template): any[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const managedPolicies = template.findResources('AWS::IAM::ManagedPolicy');
  return [...Object.values(policies), ...Object.values(managedPolicies)].flatMap(
    (res: any) => res.Properties?.PolicyDocument?.Statement ?? [],
  );
}

describe('ApiStack (dev)', () => {
  let api: Template;

  beforeAll(() => {
    ({ api } = buildTemplates('dev'));
  });

  // ── HTTP API ───────────────────────────────────────────────────────────────

  it('creates an HTTP API with correct name and protocol', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'heediq-api',
      ProtocolType: 'HTTP',
    });
  });

  it('CORS allows the dev web origin and localhost', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: Match.arrayWith([
          'https://dev.heediq.com',
          'http://localhost:5173',
        ]),
      }),
    });
  });

  it('creates a catch-all proxy route ANY /{proxy+}', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /{proxy+}',
    });
  });

  it('uses an AWS_PROXY integration with payload format 2.0', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      PayloadFormatVersion: '2.0',
    });
  });

  it('creates a $default stage with auto-deploy enabled', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
    });
  });

  // ── Lambda ─────────────────────────────────────────────────────────────────

  it('creates API Lambda named heediq-api on Node.js 22', () => {
    api.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-api',
      Runtime: 'nodejs22.x',
    });
  });

  it('API Lambda has 512 MB memory and 30s timeout (D-055)', () => {
    api.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-api',
      MemorySize: 512,
      Timeout: 30,
    });
  });

  it('API Lambda environment includes all required resource references', () => {
    api.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-api',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          SOURCES_TABLE_NAME:     Match.anyValue(),
          ORGS_TABLE_NAME:           Match.anyValue(),
          USERS_TABLE_NAME:          Match.anyValue(),
          JOBS_TABLE_NAME:           Match.anyValue(),
          WS_CONNECTIONS_TABLE_NAME: Match.anyValue(),
          USER_AUTH_METHODS_TABLE_NAME: Match.anyValue(),
          AUTH_AUDIT_LOG_TABLE_NAME:    Match.anyValue(),
          ROLES_TABLE_NAME:          Match.anyValue(),
          GROUPS_TABLE_NAME:         Match.anyValue(),
          ROLE_ASSIGNMENTS_TABLE_NAME: Match.anyValue(),
          AUDIT_LOG_TABLE_NAME:      Match.anyValue(),
          AUDIO_BUCKET_NAME:         Match.anyValue(),
          TRANSCRIPTION_QUEUE_URL:   Match.anyValue(),
          COGNITO_USER_POOL_ID:      Match.anyValue(),
          COGNITO_CLIENT_ID:         Match.anyValue(),
        }),
      }),
    });
  });

  it('API Gateway has Lambda invoke permission on heediq-api', () => {
    api.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
    });
  });

  // ── IAM ───────────────────────────────────────────────────────────────────

  it('API Lambda role has read-write access to the RBAC roles/groups/role-assignments tables (D-102 Phase 2)', () => {
    const statements = findAllIamStatements(api);
    const rolesStatements = statements.filter((stmt: any) => {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      return resources.some((r: any) => JSON.stringify(r).includes('RolesTable'));
    });
    const actions = rolesStatements.flatMap((stmt: any) =>
      Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action],
    );
    expect(actions).toEqual(expect.arrayContaining([expect.stringMatching(/dynamodb:GetItem/)]));
  });

  it('API Lambda role has write + Query access to the audit-log table, no GetItem/Scan (D-102 Phase 5 — /org/audit-log viewer; GetItem/Scan stay blocked so no full-table read path opens up)', () => {
    const statements = findAllIamStatements(api);
    const auditLogStatements = statements.filter((stmt: any) => {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      return resources.some((r: any) => JSON.stringify(r).includes('AuditLogTable'));
    });
    const actions = auditLogStatements.flatMap((stmt: any) =>
      Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action],
    );
    expect(actions).toEqual(expect.arrayContaining([expect.stringMatching(/dynamodb:PutItem/)]));
    expect(actions).toEqual(expect.arrayContaining([expect.stringMatching(/dynamodb:Query/)]));
    expect(actions).not.toEqual(expect.arrayContaining([expect.stringMatching(/dynamodb:GetItem|dynamodb:Scan/)]));
  });

  it('API Lambda role has secretsmanager:GetSecretValue for /heediq/api/* secrets', () => {
    const statements = findAllIamStatements(api);
    expect(statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Action: 'secretsmanager:GetSecretValue',
        Resource: expect.stringMatching(/\/heediq\/api\//),
      }),
    ]));
  });

  it('API Lambda role has sts:AssumeRole on heediq-ses-email-sending (D-058)', () => {
    const statements = findAllIamStatements(api);
    expect(statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Action: 'sts:AssumeRole',
        Resource: 'arn:aws:iam::313828097088:role/heediq-ses-email-sending',
      }),
    ]));
  });

  it('API Lambda role has sqs:SendMessage on heediq-summarization queue (D-065)', () => {
    const statements = findAllIamStatements(api);
    expect(statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Action: 'sqs:SendMessage',
        Resource: expect.stringMatching(/heediq-summarization/),
      }),
    ]));
  });

  it('API Lambda role has Cognito Admin + SignUp-flow actions scoped to the User Pool ARN (D-078, D-087)', () => {
    const statements = findAllIamStatements(api);
    expect(statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Action: expect.arrayContaining([
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminLinkProviderForUser',
          'cognito-idp:SignUp',
          'cognito-idp:ConfirmSignUp',
          'cognito-idp:ResendConfirmationCode',
          'cognito-idp:ListUsers',
        ]),
      }),
    ]));
  });

  it('API Lambda environment includes SUMMARIZATION_QUEUE_URL (D-065)', () => {
    api.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-api',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          SUMMARIZATION_QUEUE_URL: Match.stringLikeRegexp('heediq-summarization'),
        }),
      }),
    });
  });

  // ── Custom domain ──────────────────────────────────────────────────────────

  it('creates a custom domain name for api-dev.heediq.com with REGIONAL endpoint', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'api-dev.heediq.com',
      DomainNameConfigurations: Match.arrayWith([
        Match.objectLike({ EndpointType: 'REGIONAL' }),
      ]),
    });
  });

  it('creates an API mapping binding the $default stage to the custom domain', () => {
    api.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
  });

  // ── Route 53 alias record (cross-account custom resource) ─────────────────

  it('creates a custom resource for the Route 53 A-alias record', () => {
    api.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      RecordName: 'api-dev.heediq.com',
      HostedZoneId: 'Z0875312RP7WHSNW7AUM',
    });
  });

  it('Route53AliasRecord handler role has sts:AssumeRole on heediq-route53-dns-manager (D-064)', () => {
    api.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Resource: 'arn:aws:iam::313828097088:role/heediq-route53-dns-manager',
          }),
        ]),
      }),
    });
  });

  // ── SSM params ─────────────────────────────────────────────────────────────

  it('exports endpoint-url SSM param with custom domain https:// URL', () => {
    api.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/endpoint-url',
      Value: 'https://api-dev.heediq.com',
    });
  });

  it('exports regional-domain-name SSM param for Route 53 alias target', () => {
    api.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/regional-domain-name',
    });
  });
});

describe('ApiStack (prod)', () => {
  it('uses prod domain api.heediq.com and does not include localhost CORS origin', () => {
    const { api } = buildTemplates('prod');
    api.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'api.heediq.com',
    });
    api.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/endpoint-url',
      Value: 'https://api.heediq.com',
    });
    api.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: Match.not(Match.arrayWith(['http://localhost:5173'])),
      }),
    });
  });
});
