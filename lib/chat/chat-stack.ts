import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { WorkloadEnv, COMPUTE, logRetentionFor } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';
import { WebSocketStack } from '../websocket/websocket-stack';

export interface ChatStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
  webSocket: WebSocketStack;
}

export class ChatStack extends cdk.Stack {
  // Exported for potential future cross-stack use (e.g. additional producers)
  readonly chatQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: ChatStackProps) {
    super(scope, id, props);

    const { foundation, webSocket } = props;

    // ── SQS — chat-turn job queue (D-138/D-139) ───────────────────────────────
    // One entry point: heediq-api enqueues a job per user message; heediq-chat runs the
    // Claude turn and streams the result back over WS (chat_delta/chat_complete/chat_failed).

    const dlq = new sqs.Queue(this, 'ChatDlq', {
      queueName: 'heediq-chat-dlq',
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.chatQueue = new sqs.Queue(this, 'ChatQueue', {
      queueName: 'heediq-chat',
      // Visibility timeout must exceed Lambda timeout (300s) to avoid re-processing
      // a message while the Lambda is still running. 360s = timeout + 60s buffer.
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });

    // ── CloudWatch log group (D-093) ──────────────────────────────────────────
    const chatLogGroup = new logs.LogGroup(this, 'ChatLogGroup', {
      logGroupName: '/aws/lambda/heediq-chat',
      retention: logRetentionFor(props.workloadEnv),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda — Claude API chat worker (D-138/D-139) ─────────────────────────
    // Actual implementation deployed by heediq-chat CI. Placeholder code replaced on first
    // deploy from that repo, mirroring heediq-worker-summarization's pattern.
    const chatFn = new lambda.Function(this, 'ChatFn', {
      functionName: 'heediq-chat',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      // Placeholder — real code deployed by heediq-chat CI (D-043, D-050)
      code: lambda.Code.fromInline(
        'exports.handler = async () => { console.log("placeholder"); };',
      ),
      memorySize: COMPUTE.lambda.chat.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.chat.timeoutSecs),
      tracing: lambda.Tracing.ACTIVE, // D-085 — X-Ray active tracing, no separate observability tool
      logGroup: chatLogGroup, // D-093 — explicit retention, no unbounded log storage
      environment: {
        CONVERSATIONS_TABLE_NAME:   foundation.conversationsTable.tableName,
        CHAT_MESSAGES_TABLE_NAME:   foundation.chatMessagesTable.tableName,
        // Context memory assembled from Contexts + their extracted items / decision ledger (D-138)
        CONTEXTS_TABLE_NAME:        foundation.contextsTable.tableName,
        EXTRACTED_ITEMS_TABLE_NAME: foundation.extractedItemsTable.tableName,
        DECISION_LEDGER_TABLE_NAME: foundation.decisionLedgerTable.tableName,
        CLAUDE_SECRET_NAME:         '/heediq/chat/anthropic-api-key',
        // WS push (D-109/D-139) — this Lambda is a direct-call pusher (chat_delta/chat_complete/
        // chat_failed), same pattern as heediq-api's WS_MANAGEMENT_ENDPOINT usage. heediq-chat is a
        // separate Lambda/repo from heediq-api so it carries its own PostToConnection call, not a
        // shared import of heediq-api's src/lib/wsPush.ts.
        WS_MANAGEMENT_ENDPOINT:     webSocket.wsManagementEndpoint,
      },
    });

    // ── SQS → Lambda event source (mirrors D-065 summarization worker) ────────
    // batchSize=1: each Claude API call is a separate invocation — no partial-batch failures
    // to reason about; reportBatchItemFailures returns the message to the queue on error.
    chatFn.addEventSource(
      new lambdaEventSources.SqsEventSource(this.chatQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // ── IAM grants — least privilege (D-038) ─────────────────────────────────

    // DynamoDB — read/write the conversation + its messages
    foundation.conversationsTable.grantReadWriteData(chatFn);
    foundation.chatMessagesTable.grantReadWriteData(chatFn);

    // DynamoDB — read-only context memory the turn is grounded in (Context + extracted
    // items + decision ledger); this worker never mutates Context Library content.
    foundation.contextsTable.grantReadData(chatFn);
    foundation.extractedItemsTable.grantReadData(chatFn);
    foundation.decisionLedgerTable.grantReadData(chatFn);

    // WS push — table read/write + execute-api:ManageConnections (D-109)
    webSocket.grantPush(chatFn);

    // Secrets Manager — Claude API key fetched at cold start via direct SDK call, cached at module scope (D-100)
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/heediq/chat/*`,
        ],
      }),
    );

    // ── SSM params (D-038) ────────────────────────────────────────────────────
    // Consumed by heediq-chat CI (queue target) and future orchestration.

    new ssm.StringParameter(this, 'ChatQueueUrlParam', {
      parameterName: '/heediq/chat/queue-url',
      stringValue: this.chatQueue.queueUrl,
      description: 'SQS chat queue URL — enqueue target for chat-turn jobs',
    });

    new ssm.StringParameter(this, 'ChatQueueArnParam', {
      parameterName: '/heediq/chat/queue-arn',
      stringValue: this.chatQueue.queueArn,
      description: 'SQS chat queue ARN',
    });

    new ssm.StringParameter(this, 'ChatLambdaArnParam', {
      parameterName: '/heediq/infra/chat-lambda-arn',
      stringValue: chatFn.functionArn,
      description: 'Chat Lambda ARN — consumed by future orchestration',
    });
  }
}
