import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_events from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { WorkloadEnv, DOMAINS } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';

export interface WebSocketStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
}

export class WebSocketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebSocketStackProps) {
    super(scope, id, props);

    const wsDomain = DOMAINS.ws[props.workloadEnv];

    // ── Connection Lambda — $connect / $disconnect / $default (D-061) ──────────
    // Actual implementation deployed by app repo CI. This construct owns the IAM role,
    // env vars, and API Gateway wiring. placeholder code below is replaced on deploy.
    const connectFn = new lambda.Function(this, 'ConnectFn', {
      functionName: 'heediq-ws-connect',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      // Placeholder — real code deployed by heediq-api CI (D-043, D-050)
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200 });',
      ),
      timeout: cdk.Duration.seconds(29), // WebSocket $connect has a 29s hard limit
      environment: {
        WS_CONNECTIONS_TABLE: props.foundation.wsConnectionsTable.tableName,
        COGNITO_USER_POOL_ID: ssm.StringParameter.valueForStringParameter(
          this,
          '/heediq/api/cognito-user-pool-id',
        ),
      },
    });

    // $connect: put connectionId row; $disconnect: delete it (D-061)
    props.foundation.wsConnectionsTable.grantReadWriteData(connectFn);

    // ── Status Pusher Lambda — DDB Streams → push to clients (D-061) ─────────
    const pusherFn = new lambda.Function(this, 'PusherFn', {
      functionName: 'heediq-ws-status-pusher',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => {};',
      ),
      timeout: cdk.Duration.seconds(60),
      environment: {
        WS_CONNECTIONS_TABLE: props.foundation.wsConnectionsTable.tableName,
      },
    });

    // Query by-recording GSI; delete stale connections on GoneException (D-061)
    props.foundation.wsConnectionsTable.grantReadWriteData(pusherFn);

    // DDB Streams trigger — every MODIFY event on heediq-jobs fans out to connected clients
    pusherFn.addEventSource(
      new lambda_events.DynamoEventSource(props.foundation.jobsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 3,
        filters: [
          // Only process MODIFY events — INSERT (queued) is handled client-side
          lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('MODIFY') }),
        ],
      }),
    );

    // ── WebSocket API (D-061) ──────────────────────────────────────────────────

    const wsApi = new apigatewayv2.CfnApi(this, 'WebSocketApi', {
      name: 'heediq-ws',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    // API Gateway permission to invoke the connection Lambda
    connectFn.addPermission('ApiGwInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`,
    });

    const connectIntegration = new apigatewayv2.CfnIntegration(this, 'ConnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${connectFn.functionArn}/invocations`,
    });

    new apigatewayv2.CfnRoute(this, 'ConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    });

    new apigatewayv2.CfnRoute(this, 'DisconnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$disconnect',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    });

    new apigatewayv2.CfnRoute(this, 'DefaultRoute', {
      apiId: wsApi.ref,
      routeKey: '$default',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    });

    const stage = new apigatewayv2.CfnStage(this, 'Stage', {
      apiId: wsApi.ref,
      stageName: 'ws',
      autoDeploy: true,
    });

    // ── execute-api:ManageConnections grant (D-061) ───────────────────────────
    // Pusher Lambda calls POST /@connections/{connectionId} to push status to clients.
    // Resource: arn:aws:execute-api:REGION:ACCOUNT:API_ID/STAGE/POST/@connections/*
    pusherFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [
          `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/${stage.ref}/POST/@connections/*`,
        ],
      }),
    );

    // ── Custom domain (D-052, D-053) ─────────────────────────────────────────
    // Cert comes from FoundationStack.wildcardCert — same workload account, same region.
    const domainName = new apigatewayv2.CfnDomainName(this, 'DomainName', {
      domainName: wsDomain,
      domainNameConfigurations: [
        {
          certificateArn: props.foundation.wildcardCert.certificateArn,
          endpointType: 'REGIONAL',
        },
      ],
    });

    new apigatewayv2.CfnApiMapping(this, 'ApiMapping', {
      apiId: wsApi.ref,
      domainName: domainName.ref,
      stage: stage.ref,
    });

    // TODO: Route 53 A-alias record → domainName.attrRegionalDomainName
    // Requires cross-account grants on the shared-services hosted zone.
    // Add when Route 53 cross-account IAM grants are set up (same work as ApiStack / WebStack).

    // ── SSM params (D-038) ────────────────────────────────────────────────────

    new ssm.StringParameter(this, 'WsEndpointUrlParam', {
      parameterName: '/heediq/api/ws-endpoint-url',
      stringValue: `wss://${wsDomain}`,
      description: 'WebSocket API endpoint URL (wss://)',
    });

    // Regional domain name for Route 53 alias target (stored so it survives stack drifts)
    new ssm.StringParameter(this, 'WsRegionalDomainParam', {
      parameterName: '/heediq/api/ws-regional-domain-name',
      stringValue: domainName.attrRegionalDomainName,
      description: 'API Gateway WebSocket regional domain name (Route 53 alias target)',
    });
  }
}
