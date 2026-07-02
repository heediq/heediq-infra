import { describe, it, beforeAll } from 'vitest';
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

  it('API Lambda role has secretsmanager:GetSecretValue for /heediq/api/* secrets', () => {
    api.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Resource: Match.stringLikeRegexp('/heediq/api/'),
          }),
        ]),
      }),
    });
  });

  it('API Lambda role has sts:AssumeRole on heediq-ses-email-sending (D-058)', () => {
    api.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Resource: 'arn:aws:iam::313828097088:role/heediq-ses-email-sending',
          }),
        ]),
      }),
    });
  });

  it('API Lambda role has sqs:SendMessage on heediq-summarization queue (D-065)', () => {
    api.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sqs:SendMessage',
            Resource: Match.stringLikeRegexp('heediq-summarization'),
          }),
        ]),
      }),
    });
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
