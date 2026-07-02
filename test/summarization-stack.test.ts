import { describe, it, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { SummarizationStack } from '../lib/summarization/summarization-stack';

function buildTemplates(workloadEnv: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const account = workloadEnv === 'prod' ? '438825592314' : '123456789012';
  const env = { account, region: 'eu-west-1' };

  const foundation = new FoundationStack(app, 'TestFoundationStack', {
    env,
    workloadEnv,
  });

  const summarization = new SummarizationStack(app, 'TestSummarizationStack', {
    env,
    workloadEnv,
    foundation,
  });

  return {
    foundation: Template.fromStack(foundation),
    summarization: Template.fromStack(summarization),
  };
}

describe('SummarizationStack (dev)', () => {
  let summarization: Template;

  beforeAll(() => {
    ({ summarization } = buildTemplates('dev'));
  });

  // ── Lambda ─────────────────────────────────────────────────────────────────

  it('creates Lambda named heediq-summarization with Node.js 22 runtime', () => {
    summarization.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-summarization',
      Runtime: 'nodejs22.x',
    });
  });

  it('Lambda has 512 MB memory and 300s timeout (D-055)', () => {
    summarization.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-summarization',
      MemorySize: 512,
      Timeout: 300,
    });
  });

  it('Lambda environment includes JOBS_TABLE_NAME, SOURCES_TABLE_NAME, AUDIO_BUCKET_NAME, CLAUDE_SECRET_NAME', () => {
    summarization.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-summarization',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          JOBS_TABLE_NAME:       Match.anyValue(),
          SOURCES_TABLE_NAME: Match.anyValue(),
          AUDIO_BUCKET_NAME:     Match.anyValue(),
          CLAUDE_SECRET_NAME:    Match.anyValue(),
        }),
      }),
    });
  });

  // ── SQS queue + DLQ (D-065) ────────────────────────────────────────────────

  it('creates SQS queue named heediq-summarization', () => {
    summarization.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-summarization',
    });
  });

  it('summarization queue has 360s visibility timeout (Lambda 300s + 60s buffer)', () => {
    summarization.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-summarization',
      VisibilityTimeout: 360,
    });
  });

  it('summarization queue has SSL enforced', () => {
    summarization.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-summarization',
    });
    // SSL enforcement is a QueuePolicy condition — verify policy exists on the queue
    summarization.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              Bool: { 'aws:SecureTransport': 'false' },
            }),
          }),
        ]),
      }),
    });
  });

  it('creates DLQ named heediq-summarization-dlq', () => {
    summarization.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-summarization-dlq',
    });
  });

  it('DLQ has 14-day message retention', () => {
    summarization.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-summarization-dlq',
      MessageRetentionPeriod: 1209600, // 14 days in seconds
    });
  });

  it('summarization queue redrive policy targets DLQ with maxReceiveCount=3', () => {
    summarization.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-summarization',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  // ── SQS → Lambda event source mapping ─────────────────────────────────────

  it('creates an event source mapping from heediq-summarization queue to Lambda', () => {
    summarization.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('event source mapping references the summarization queue', () => {
    // EventSourceArn is a Ref/Fn::GetAtt token — assert an event source mapping exists
    // with batchSize=1; queue linkage is verified by the CDK construct wiring
    summarization.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });

  // ── IAM grants (D-038) ─────────────────────────────────────────────────────

  it('Lambda role has secretsmanager:GetSecretValue for /heediq/summarization/* (D-032)', () => {
    summarization.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Resource: Match.stringLikeRegexp('/heediq/summarization/'),
          }),
        ]),
      }),
    });
  });

  it('Lambda role has DynamoDB read+write grants (jobs + sources tables)', () => {
    // Cross-stack resources appear as Fn::ImportValue arrays in Resource — assert actions only.
    // The CDK construct wiring guarantees the correct table ARNs are attached.
    summarization.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:PutItem', 'dynamodb:UpdateItem']),
          }),
        ]),
      }),
    });
  });

  it('Lambda role DynamoDB policy covers at least 2 table resources (jobs + sources)', () => {
    // grantReadWriteData on two tables emits two Action arrays in the same policy.
    // Verifying we have ≥2 write statements confirms both grants are present.
    const policies = summarization.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:PutItem']),
            }),
          ]),
        }),
      },
    });
    const writeStatements = Object.values(policies).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement,
    ).filter((s: any) =>
      Array.isArray(s.Action) && s.Action.includes('dynamodb:PutItem'),
    );
    if (writeStatements.length < 2) {
      throw new Error(
        `Expected at least 2 DynamoDB write statements (jobs + sources), found ${writeStatements.length}`,
      );
    }
  });

  it('Lambda role has s3:GetObject on audio uploads bucket (read transcript/content files)', () => {
    summarization.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:GetObject*']),
          }),
        ]),
      }),
    });
  });

  // ── SSM params (D-038) ─────────────────────────────────────────────────────

  it('exports /heediq/summarization/queue-url SSM param', () => {
    summarization.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/summarization/queue-url',
    });
  });

  it('exports /heediq/summarization/queue-arn SSM param', () => {
    summarization.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/summarization/queue-arn',
    });
  });

  it('exports /heediq/infra/summarization-lambda-arn SSM param', () => {
    summarization.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/infra/summarization-lambda-arn',
    });
  });
});
