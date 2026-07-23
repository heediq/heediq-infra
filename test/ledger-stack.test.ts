import { describe, it, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { WebSocketStack } from '../lib/websocket/websocket-stack';
import { LedgerStack } from '../lib/ledger/ledger-stack';

function buildTemplates(workloadEnv: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const account = workloadEnv === 'prod' ? '438825592314' : '123456789012';
  const env = { account, region: 'eu-west-1' };

  const foundation = new FoundationStack(app, 'TestFoundationStack', {
    env,
    workloadEnv,
  });

  const webSocket = new WebSocketStack(app, 'TestWebSocketStack', {
    env,
    workloadEnv,
    foundation,
  });

  const ledger = new LedgerStack(app, 'TestLedgerStack', {
    env,
    workloadEnv,
    foundation,
    webSocket,
  });

  return {
    foundation: Template.fromStack(foundation),
    ledger: Template.fromStack(ledger),
  };
}

describe('LedgerStack (dev)', () => {
  let ledger: Template;

  beforeAll(() => {
    ({ ledger } = buildTemplates('dev'));
  });

  // ── Lambda ─────────────────────────────────────────────────────────────────

  it('creates Lambda named heediq-ledger with Node.js 22 runtime', () => {
    ledger.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ledger',
      Runtime: 'nodejs22.x',
    });
  });

  it('Lambda has 512 MB memory and 300s timeout', () => {
    ledger.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ledger',
      MemorySize: 512,
      Timeout: 300,
    });
  });

  it('Lambda environment includes context/extracted-items/decision-ledger/secret/ws vars', () => {
    ledger.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ledger',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          CONTEXTS_TABLE_NAME:        Match.anyValue(),
          EXTRACTED_ITEMS_TABLE_NAME: Match.anyValue(),
          DECISION_LEDGER_TABLE_NAME: Match.anyValue(),
          CLAUDE_SECRET_NAME:         Match.anyValue(),
          WS_MANAGEMENT_ENDPOINT:     Match.anyValue(),
        }),
      }),
    });
  });

  it('Lambda environment includes WS_CONNECTIONS_TABLE_NAME (own WS-push, D-109/D-139)', () => {
    // heediq-ledger can't import heediq-api's src/lib/wsPush.ts (separate Lambda/repo) — it needs
    // the connections table name directly to query by-user for target connectionIds.
    ledger.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ledger',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          WS_CONNECTIONS_TABLE_NAME: Match.anyValue(),
        }),
      }),
    });
  });

  // ── SQS queue + DLQ ────────────────────────────────────────────────────────

  it('creates SQS queue named heediq-ledger', () => {
    ledger.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-ledger',
    });
  });

  it('ledger queue has 360s visibility timeout (Lambda 300s + 60s buffer)', () => {
    ledger.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-ledger',
      VisibilityTimeout: 360,
    });
  });

  it('ledger queue has SSL enforced', () => {
    ledger.hasResourceProperties('AWS::SQS::QueuePolicy', {
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

  it('creates DLQ named heediq-ledger-dlq', () => {
    ledger.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-ledger-dlq',
    });
  });

  it('DLQ has 14-day message retention', () => {
    ledger.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-ledger-dlq',
      MessageRetentionPeriod: 1209600, // 14 days in seconds
    });
  });

  it('ledger queue redrive policy targets DLQ with maxReceiveCount=3', () => {
    ledger.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-ledger',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  // ── SQS → Lambda event source mapping ─────────────────────────────────────

  it('creates an event source mapping from heediq-ledger queue to Lambda', () => {
    ledger.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('creates exactly one event source mapping', () => {
    ledger.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });

  // ── IAM grants (D-038) ─────────────────────────────────────────────────────

  it('Lambda role has secretsmanager:GetSecretValue for /heediq/ledger/*', () => {
    ledger.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Resource: Match.stringLikeRegexp('/heediq/ledger/'),
          }),
        ]),
      }),
    });
  });

  it('Lambda role has execute-api:ManageConnections (D-109 grantPush)', () => {
    ledger.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'execute-api:ManageConnections',
          }),
        ]),
      }),
    });
  });

  it('Lambda role has a DynamoDB write grant on the decision-ledger table', () => {
    const policies = ledger.findResources('AWS::IAM::Policy');
    const writeStatements = Object.values(policies)
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => Array.isArray(s.Action) && s.Action.includes('dynamodb:PutItem'));
    if (writeStatements.length < 1) {
      throw new Error(
        `Expected ≥1 DynamoDB write statement (decision-ledger), found ${writeStatements.length}`,
      );
    }
  });

  it('Lambda role has read-only DynamoDB grants for contexts + extracted-items', () => {
    const policies = ledger.findResources('AWS::IAM::Policy');
    const readOnlyStatements = Object.values(policies)
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) =>
        Array.isArray(s.Action) &&
        s.Action.includes('dynamodb:Query') &&
        !s.Action.includes('dynamodb:PutItem'),
      );
    if (readOnlyStatements.length < 2) {
      throw new Error(
        `Expected ≥2 read-only DynamoDB statements (contexts + extracted-items), found ${readOnlyStatements.length}`,
      );
    }
  });

  // ── SSM params (D-038) ─────────────────────────────────────────────────────

  it('exports /heediq/ledger/queue-url SSM param', () => {
    ledger.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/ledger/queue-url',
    });
  });

  it('exports /heediq/ledger/queue-arn SSM param', () => {
    ledger.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/ledger/queue-arn',
    });
  });

  it('exports /heediq/infra/ledger-lambda-arn SSM param', () => {
    ledger.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/infra/ledger-lambda-arn',
    });
  });
});
