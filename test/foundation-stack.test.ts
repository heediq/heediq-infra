import { describe, it, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';

describe('FoundationStack (dev)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new FoundationStack(app, 'TestFoundationStack', {
      env: { account: '123456789012', region: 'eu-west-1' },
      workloadEnv: 'dev',
    });
    template = Template.fromStack(stack);
  });

  // ── DynamoDB ───────────────────────────────────────────────────────────────

  it('creates 4 DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 4);
  });

  it('all tables use PAY_PER_REQUEST with PITR enabled', () => {
    template.allResourcesProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: Match.objectLike({ PointInTimeRecoveryEnabled: true }),
    });
  });

  it('recordings table has correct key schema and 2 GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-recordings',
      KeySchema: [
        { AttributeName: 'orgId', KeyType: 'HASH' },
        { AttributeName: 'recordingId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-org-created' }),
        Match.objectLike({ IndexName: 'by-user-created' }),
      ]),
    });
  });

  it('orgs table has emailDomain GSI for request-to-join lookup', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-orgs',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-email-domain' }),
      ]),
    });
  });

  it('users table has orgId GSI for member listing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-users',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-org' }),
      ]),
    });
  });

  it('jobs table uses recordingId as partition key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-jobs',
      KeySchema: [{ AttributeName: 'recordingId', KeyType: 'HASH' }],
    });
  });

  // ── SQS ────────────────────────────────────────────────────────────────────

  it('creates transcription queue with 1h visibility timeout and DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-transcription',
      VisibilityTimeout: 3600,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('creates transcription DLQ with 14-day retention', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-transcription-dlq',
      MessageRetentionPeriod: 1209600, // 14 days in seconds
    });
  });

  // ── S3 ─────────────────────────────────────────────────────────────────────

  it('creates 2 S3 buckets, both blocking public access', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('audio uploads bucket has CORS and Glacier lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: Match.objectLike({
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: Match.arrayWith(['PUT']),
            AllowedOrigins: Match.arrayWith(['http://localhost:5173']),
          }),
        ]),
      }),
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({ Id: 'archive-to-glacier-deep' }),
          Match.objectLike({ Id: 'abort-incomplete-multipart' }),
        ]),
      }),
    });
  });

  it('audio bucket SQS notification — queue policy allows s3.amazonaws.com to send', () => {
    // CDK wires S3→SQS via a Lambda-backed custom resource; the verifiable contract is
    // the SQS queue policy granting s3.amazonaws.com SendMessage access.
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:SendMessage']),
            Principal: Match.objectLike({ Service: 's3.amazonaws.com' }),
          }),
        ]),
      }),
    });
  });

  // ── Cognito ────────────────────────────────────────────────────────────────

  it('creates User Pool with email alias and auto-verification', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      UserPoolName: 'heediq-users',
    });
  });

  it('creates Cognito hosted domain with env prefix', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'heediq-dev',
    });
  });

  it('creates Google and Microsoft IdP providers', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 2);
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'Google',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'OIDC',
      ProviderName: 'Microsoft',
    });
  });

  it('User Pool client includes localhost callback URLs for dev', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['http://localhost:5173/auth/callback']),
      LogoutURLs: Match.arrayWith(['http://localhost:5173']),
    });
  });

  it('User Pool client has no secret (public browser client)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  // ── SSM params ─────────────────────────────────────────────────────────────

  it('exports all 12 required SSM parameters', () => {
    const expectedParams = [
      '/heediq/api/recordings-table-name',
      '/heediq/api/orgs-table-name',
      '/heediq/api/users-table-name',
      '/heediq/api/jobs-table-name',
      '/heediq/api/audio-bucket-name',
      '/heediq/api/web-assets-bucket-name',
      '/heediq/api/transcription-queue-url',
      '/heediq/api/transcription-queue-arn',
      '/heediq/api/cognito-user-pool-id',
      '/heediq/api/cognito-user-pool-arn',
      '/heediq/api/cognito-client-id',
      '/heediq/api/ses-sending-role-arn',
    ];
    for (const name of expectedParams) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: name });
    }
  });
});

describe('FoundationStack (prod)', () => {
  it('uses RETAIN removal policy — no DESTROY or autoDeleteObjects', () => {
    const app = new cdk.App();
    const stack = new FoundationStack(app, 'ProdFoundationStack', {
      env: { account: '438825592314', region: 'eu-west-1' },
      workloadEnv: 'prod',
    });
    const template = Template.fromStack(stack);

    // autoDeleteObjects custom resource should NOT exist in prod
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);

    // All DynamoDB tables should have DeletionPolicy: Retain
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const [, resource] of Object.entries(tables)) {
      const r = resource as { DeletionPolicy?: string };
      if (r.DeletionPolicy !== undefined) {
        // If set, must be Retain
        if (r.DeletionPolicy !== 'Retain') {
          throw new Error(`DynamoDB table has DeletionPolicy ${r.DeletionPolicy}, expected Retain`);
        }
      }
    }
  });

  it('Cognito hosted domain uses prod prefix', () => {
    const app = new cdk.App();
    const stack = new FoundationStack(app, 'ProdFoundationStack2', {
      env: { account: '438825592314', region: 'eu-west-1' },
      workloadEnv: 'prod',
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'heediq-prod',
    });
  });

  it('prod User Pool client has no localhost callback URLs', () => {
    const app = new cdk.App();
    const stack = new FoundationStack(app, 'ProdFoundationStack3', {
      env: { account: '438825592314', region: 'eu-west-1' },
      workloadEnv: 'prod',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.not(Match.arrayWith(['http://localhost:5173/auth/callback'])),
    });
  });
});
