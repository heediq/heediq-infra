import { describe, it, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { WebSocketStack } from '../lib/websocket/websocket-stack';
import { ChatStack } from '../lib/chat/chat-stack';

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

  const chat = new ChatStack(app, 'TestChatStack', {
    env,
    workloadEnv,
    foundation,
    webSocket,
  });

  return {
    foundation: Template.fromStack(foundation),
    chat: Template.fromStack(chat),
  };
}

describe('ChatStack (dev)', () => {
  let chat: Template;

  beforeAll(() => {
    ({ chat } = buildTemplates('dev'));
  });

  // ── Lambda ─────────────────────────────────────────────────────────────────

  it('creates Lambda named heediq-chat with Node.js 22 runtime', () => {
    chat.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-chat',
      Runtime: 'nodejs22.x',
    });
  });

  it('Lambda has 512 MB memory and 300s timeout', () => {
    chat.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-chat',
      MemorySize: 512,
      Timeout: 300,
    });
  });

  it('Lambda environment includes conversations/chat-messages/context/secret/ws vars', () => {
    chat.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-chat',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          CONVERSATIONS_TABLE_NAME:   Match.anyValue(),
          CHAT_MESSAGES_TABLE_NAME:   Match.anyValue(),
          CONTEXTS_TABLE_NAME:        Match.anyValue(),
          EXTRACTED_ITEMS_TABLE_NAME: Match.anyValue(),
          DECISION_LEDGER_TABLE_NAME: Match.anyValue(),
          CLAUDE_SECRET_NAME:         Match.anyValue(),
          WS_MANAGEMENT_ENDPOINT:     Match.anyValue(),
        }),
      }),
    });
  });

  // ── SQS queue + DLQ ────────────────────────────────────────────────────────

  it('creates SQS queue named heediq-chat', () => {
    chat.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-chat',
    });
  });

  it('chat queue has 360s visibility timeout (Lambda 300s + 60s buffer)', () => {
    chat.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-chat',
      VisibilityTimeout: 360,
    });
  });

  it('chat queue has SSL enforced', () => {
    chat.hasResourceProperties('AWS::SQS::QueuePolicy', {
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

  it('creates DLQ named heediq-chat-dlq', () => {
    chat.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-chat-dlq',
    });
  });

  it('DLQ has 14-day message retention', () => {
    chat.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-chat-dlq',
      MessageRetentionPeriod: 1209600, // 14 days in seconds
    });
  });

  it('chat queue redrive policy targets DLQ with maxReceiveCount=3', () => {
    chat.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-chat',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  // ── SQS → Lambda event source mapping ─────────────────────────────────────

  it('creates an event source mapping from heediq-chat queue to Lambda', () => {
    chat.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('creates exactly one event source mapping', () => {
    chat.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });

  // ── IAM grants (D-038) ─────────────────────────────────────────────────────

  it('Lambda role has secretsmanager:GetSecretValue for /heediq/chat/*', () => {
    chat.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Resource: Match.stringLikeRegexp('/heediq/chat/'),
          }),
        ]),
      }),
    });
  });

  it('Lambda role has execute-api:ManageConnections (D-109 grantPush)', () => {
    chat.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'execute-api:ManageConnections',
          }),
        ]),
      }),
    });
  });

  it('Lambda role DynamoDB policy has ≥2 write statements (conversations + chat-messages)', () => {
    const policies = chat.findResources('AWS::IAM::Policy');
    const writeStatements = Object.values(policies)
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => Array.isArray(s.Action) && s.Action.includes('dynamodb:PutItem'));
    if (writeStatements.length < 2) {
      throw new Error(
        `Expected ≥2 DynamoDB write statements (conversations + chat-messages), found ${writeStatements.length}`,
      );
    }
  });

  it('Lambda role has read-only DynamoDB grants for contexts/extracted-items/decision-ledger', () => {
    const policies = chat.findResources('AWS::IAM::Policy');
    const readOnlyStatements = Object.values(policies)
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) =>
        Array.isArray(s.Action) &&
        s.Action.includes('dynamodb:Query') &&
        !s.Action.includes('dynamodb:PutItem'),
      );
    if (readOnlyStatements.length < 3) {
      throw new Error(
        `Expected ≥3 read-only DynamoDB statements (contexts + extracted-items + decision-ledger), found ${readOnlyStatements.length}`,
      );
    }
  });

  // ── SSM params (D-038) ─────────────────────────────────────────────────────

  it('exports /heediq/chat/queue-url SSM param', () => {
    chat.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/chat/queue-url',
    });
  });

  it('exports /heediq/chat/queue-arn SSM param', () => {
    chat.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/chat/queue-arn',
    });
  });

  it('exports /heediq/infra/chat-lambda-arn SSM param', () => {
    chat.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/infra/chat-lambda-arn',
    });
  });
});
