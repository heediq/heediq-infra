import { describe, it, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { WebSocketStack } from '../lib/websocket/websocket-stack';

function buildTemplates(workloadEnv: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const account = workloadEnv === 'prod' ? '438825592314' : '123456789012';
  const env = { account, region: 'eu-west-1' };

  const foundation = new FoundationStack(app, 'TestFoundationStack', {
    env,
    workloadEnv,
  });

  const wsStack = new WebSocketStack(app, 'TestWebSocketStack', {
    env,
    workloadEnv,
    foundation,
  });

  return {
    foundation: Template.fromStack(foundation),
    ws: Template.fromStack(wsStack),
  };
}

describe('WebSocketStack (dev)', () => {
  let ws: Template;

  beforeAll(() => {
    ({ ws } = buildTemplates('dev'));
  });

  // ── API Gateway WebSocket API ──────────────────────────────────────────────

  it('creates a WebSocket API with correct name and protocol', () => {
    ws.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'heediq-ws',
      ProtocolType: 'WEBSOCKET',
      RouteSelectionExpression: '$request.body.action',
    });
  });

  it('creates $connect, $disconnect, and $default routes', () => {
    ws.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$connect' });
    ws.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$disconnect' });
    ws.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
  });

  it('all routes use the connect Lambda integration (AWS_PROXY)', () => {
    ws.resourceCountIs('AWS::ApiGatewayV2::Integration', 1);
    ws.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
    });
  });

  it('creates a stage named "ws" with auto-deploy enabled', () => {
    ws.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: 'ws',
      AutoDeploy: true,
    });
  });

  // ── Lambda functions ───────────────────────────────────────────────────────

  it('creates connection Lambda named heediq-ws-connect on Node.js 22', () => {
    ws.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ws-connect',
      Runtime: 'nodejs22.x',
    });
  });

  it('creates status pusher Lambda named heediq-ws-status-pusher on Node.js 22', () => {
    ws.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ws-status-pusher',
      Runtime: 'nodejs22.x',
    });
  });

  it('connection Lambda has 29s timeout (WebSocket $connect hard limit)', () => {
    ws.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ws-connect',
      Timeout: 29,
    });
  });

  it('connection Lambda environment includes WS_CONNECTIONS_TABLE and COGNITO_USER_POOL_ID', () => {
    ws.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ws-connect',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          WS_CONNECTIONS_TABLE: Match.anyValue(),
          COGNITO_USER_POOL_ID: Match.anyValue(),
        }),
      }),
    });
  });

  it('pusher Lambda environment includes WS_CONNECTIONS_TABLE', () => {
    ws.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ws-status-pusher',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          WS_CONNECTIONS_TABLE: Match.anyValue(),
        }),
      }),
    });
  });

  // ── DDB Streams event source ───────────────────────────────────────────────

  it('status pusher has a DDB event source mapping on heediq-jobs stream', () => {
    ws.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BatchSize: 10,
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 3,
    });
  });

  it('event source mapping has a MODIFY-only filter', () => {
    ws.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: Match.objectLike({
        Filters: Match.arrayWith([
          Match.objectLike({
            Pattern: Match.stringLikeRegexp('MODIFY'),
          }),
        ]),
      }),
    });
  });

  // ── IAM ───────────────────────────────────────────────────────────────────

  it('pusher Lambda role has execute-api:ManageConnections permission', () => {
    ws.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'execute-api:ManageConnections',
          }),
        ]),
      }),
    });
  });

  it('API Gateway has Lambda invoke permission on the connection function', () => {
    ws.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
    });
  });

  // ── SSM params ─────────────────────────────────────────────────────────────
  // Custom domain (ws-dev.heediq.com) deferred — API Gateway requires the ACM cert to be
  // in the same account; shared-services cert cannot be referenced cross-account.

  it('exports ws-endpoint-url SSM param with default API Gateway wss:// URL', () => {
    ws.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/ws-endpoint-url',
    });
    ws.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    ws.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 0);
  });
});

describe('WebSocketStack (prod)', () => {
  it('exports ws-endpoint-url SSM param', () => {
    const { ws } = buildTemplates('prod');
    ws.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/ws-endpoint-url',
    });
    ws.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
  });
});
