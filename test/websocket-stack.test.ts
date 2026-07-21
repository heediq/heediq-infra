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

  // ── Classification pusher — heediq-sources stream → classification_ready (D-133) ──

  it('creates classification pusher Lambda named heediq-ws-classification-pusher on Node.js 22', () => {
    ws.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ws-classification-pusher',
      Runtime: 'nodejs22.x',
      Environment: Match.objectLike({
        Variables: Match.objectLike({ WS_CONNECTIONS_TABLE: Match.anyValue() }),
      }),
    });
  });

  it('classification pusher event source filters to Sources entering pending_review', () => {
    ws.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: Match.objectLike({
        Filters: Match.arrayWith([
          Match.objectLike({ Pattern: Match.stringLikeRegexp('pending_review') }),
        ]),
      }),
    });
  });

  // ── IAM ───────────────────────────────────────────────────────────────────

  it('pusher Lambda role has execute-api:ManageConnections permission (via grantPush)', () => {
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

  // ── DynamoDB GSIs (D-109) ───────────────────────────────────────────────────

  it('ws-connections table has by-user, by-org, and by-broadcast GSIs (no by-source)', () => {
    const { foundation } = buildTemplates('dev');
    foundation.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'by-user',
          KeySchema: Match.arrayWith([Match.objectLike({ AttributeName: 'userId' })]),
        }),
        Match.objectLike({
          IndexName: 'by-org',
          KeySchema: Match.arrayWith([Match.objectLike({ AttributeName: 'orgId' })]),
        }),
        Match.objectLike({
          IndexName: 'by-broadcast',
          KeySchema: Match.arrayWith([Match.objectLike({ AttributeName: 'broadcastKey' })]),
        }),
      ]),
    });
  });

  it('API Gateway has Lambda invoke permission on the connection function', () => {
    ws.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
    });
  });

  // ── Route 53 alias record (cross-account custom resource) ────────────────

  it('creates a custom resource for the Route 53 A-alias record', () => {
    ws.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      RecordName: 'ws-dev.heediq.com',
      HostedZoneId: 'Z0875312RP7WHSNW7AUM',
    });
  });

  it('Route53AliasRecord handler Lambda uses Node.js 22 with 5-minute timeout', () => {
    ws.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 300,
    });
  });

  it('Route53AliasRecord handler role has sts:AssumeRole on heediq-route53-dns-manager', () => {
    ws.hasResourceProperties('AWS::IAM::Policy', {
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

  // ── Custom domain ──────────────────────────────────────────────────────────

  it('creates a custom domain name for ws-dev.heediq.com with REGIONAL endpoint', () => {
    ws.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'ws-dev.heediq.com',
      DomainNameConfigurations: Match.arrayWith([
        Match.objectLike({ EndpointType: 'REGIONAL' }),
      ]),
    });
  });

  it('creates an API mapping binding the stage to the custom domain', () => {
    ws.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
  });

  // ── SSM params ─────────────────────────────────────────────────────────────

  it('exports ws-endpoint-url SSM param with custom domain wss:// URL', () => {
    ws.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/ws-endpoint-url',
      Value: 'wss://ws-dev.heediq.com',
    });
  });

  it('exports ws-regional-domain-name SSM param for Route 53 alias target', () => {
    ws.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/ws-regional-domain-name',
    });
  });

  it('exports ws-management-endpoint SSM param for server-side PostToConnection calls (D-109)', () => {
    ws.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/ws-management-endpoint',
    });
  });
});

describe('WebSocketStack (prod)', () => {
  it('uses prod domain ws.heediq.com', () => {
    const { ws } = buildTemplates('prod');
    ws.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'ws.heediq.com',
    });
    ws.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/api/ws-endpoint-url',
      Value: 'wss://ws.heediq.com',
    });
  });
});
