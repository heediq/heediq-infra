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

  // ── ACM cert ───────────────────────────────────────────────────────────────

  it('creates a wildcard ACM cert with DNS validation for *.heediq.com', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: '*.heediq.com',
      SubjectAlternativeNames: ['heediq.com'],
      ValidationMethod: 'DNS',
    });
  });

  it('exports wildcard cert ARN to SSM /heediq/infra/cert-arn-eu-west-1', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/infra/cert-arn-eu-west-1',
    });
  });

  // ── DynamoDB ───────────────────────────────────────────────────────────────

  it('creates 8 DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 8);
  });

  it('all tables use PAY_PER_REQUEST', () => {
    template.allResourcesProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('all non-ws-connections, non-rate-limits tables have PITR enabled', () => {
    // ws-connections is ephemeral (TTL-managed) — PITR not required
    // rate-limits (D-097) is a transient fixed-window counter — PITR not required
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const [, resource] of Object.entries(tables)) {
      const props = (resource as { Properties: Record<string, unknown> }).Properties;
      if (props['TableName'] === 'heediq-ws-connections') continue;
      if (props['TableName'] === 'heediq-rate-limits') continue;
      const pitr = props['PointInTimeRecoverySpecification'] as { PointInTimeRecoveryEnabled?: boolean } | undefined;
      if (!pitr?.PointInTimeRecoveryEnabled) {
        throw new Error(`Table ${String(props['TableName'])} is missing PITR`);
      }
    }
  });

  it('sources table has correct key schema and 2 GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-sources',
      KeySchema: [
        { AttributeName: 'orgId', KeyType: 'HASH' },
        { AttributeName: 'sourceId', KeyType: 'RANGE' },
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

  it('users table has email GSI for cross-provider account linking (D-078)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-users',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'by-email',
          KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
        }),
      ]),
    });
  });

  it('jobs table uses sourceId as partition key with DDB Streams NEW_IMAGE enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-jobs',
      KeySchema: [{ AttributeName: 'sourceId', KeyType: 'HASH' }],
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    });
  });

  it('ws-connections table has connectionId PK, expiresAt TTL, and by-source GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-ws-connections',
      KeySchema: [{ AttributeName: 'connectionId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-source' }),
      ]),
    });
  });

  it('user-auth-methods table has pk/sk key schema (D-087)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-user-auth-methods',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });

  it('auth-audit-log table has pk/sk key schema (D-087)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-auth-audit-log',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
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

  // Regression for OTP non-delivery: with no `email:` config, Cognito silently falls back to
  // its own default mailer instead of SES — confirmation codes were never actually reaching
  // real inboxes reliably. The User Pool must declare EmailConfiguration with SES as the
  // source, not leave it unset (D-095).
  it('wires the User Pool to send email via SES, not Cognito\'s default mailer (D-095)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: Match.objectLike({
        EmailSendingAccount: 'DEVELOPER',
        From: Match.stringLikeRegexp(`^Heediq <noreply@heediq\\.com>$`),
      }),
    });
  });

  it('creates a same-account SES identity for heediq.com with DKIM signing (D-095)', () => {
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'heediq.com',
      DkimAttributes: { SigningEnabled: true },
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

  it('User Pool client registers the settings link-callback URL (D-083)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith([
        Match.stringLikeRegexp('/settings/link-callback$'),
      ]),
    });
  });

  it('User Pool client has no secret (public browser client)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  it('User Pool defines custom:orgId and custom:role attributes', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'orgId', Mutable: true }),
        Match.objectLike({ Name: 'role', Mutable: true }),
      ]),
    });
  });

  it('wires the auth-provision Lambda as the PreTokenGeneration trigger (D-077)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: Match.objectLike({
        PreTokenGeneration: Match.anyValue(),
      }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-auth-provision',
      Environment: {
        Variables: Match.objectLike({
          ORGS_TABLE_NAME: Match.anyValue(),
          USERS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('wires the 3 cross-provider linking triggers (D-087)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: Match.objectLike({
        PreSignUp: Match.anyValue(),
        PostConfirmation: Match.anyValue(),
        PostAuthentication: Match.anyValue(),
      }),
    });
    for (const functionName of [
      'heediq-auth-trigger-pre-signup',
      'heediq-auth-trigger-post-confirmation',
      'heediq-auth-trigger-post-authentication',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: functionName });
    }
  });

  it('pre-signup and post-authentication triggers get least-privilege Cognito IAM, scoped to account/region not `*`', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'PreSignUpCognitoAccess',
            Action: Match.arrayWith(['cognito-idp:AdminLinkProviderForUser']),
            Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
          }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'PostAuthenticationCognitoAccess',
            Action: Match.arrayWith(['cognito-idp:AdminLinkProviderForUser']),
            Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
          }),
        ]),
      }),
    });
  });

  // ── S3 bucket policies ────────────────────────────────────────────────────

  it('web-assets bucket policy allows cloudfront.amazonaws.com with source-account condition (OAC)', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudFrontOAC',
            Action: 's3:GetObject',
            Principal: Match.objectLike({ Service: 'cloudfront.amazonaws.com' }),
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({ 'AWS:SourceAccount': Match.anyValue() }),
            }),
          }),
        ]),
      }),
    });
  });

  // ── SSM params ─────────────────────────────────────────────────────────────

  it('exports all 15 required SSM parameters', () => {
    const expectedParams = [
      '/heediq/infra/cert-arn-eu-west-1',
      '/heediq/api/sources-table-name',
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
      '/heediq/api/cognito-hosted-ui-domain',
      '/heediq/api/ses-sending-role-arn',
      '/heediq/api/ws-connections-table-name',
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
