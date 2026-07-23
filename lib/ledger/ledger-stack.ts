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

export interface LedgerStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
  webSocket: WebSocketStack;
}

export class LedgerStack extends cdk.Stack {
  // Exported for potential future cross-stack use (e.g. additional producers)
  readonly ledgerQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: LedgerStackProps) {
    super(scope, id, props);

    const { foundation, webSocket } = props;

    // ── SQS — Decision Ledger reconciliation queue (D-148/D-136) ──────────────
    // One entry point: heediq-api enqueues a job on review-approval (persist-then-review); the
    // heediq-ledger worker loads the existing ledger + this source's kept items, makes one
    // prompt-cached Claude call, persists entries with computed status, and pushes ledger_ready.

    const dlq = new sqs.Queue(this, 'LedgerDlq', {
      queueName: 'heediq-ledger-dlq',
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.ledgerQueue = new sqs.Queue(this, 'LedgerQueue', {
      queueName: 'heediq-ledger',
      // Visibility timeout must exceed Lambda timeout (300s) to avoid re-processing
      // a message while the Lambda is still running. 360s = timeout + 60s buffer.
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });

    // ── CloudWatch log group (D-093) ──────────────────────────────────────────
    const ledgerLogGroup = new logs.LogGroup(this, 'LedgerLogGroup', {
      logGroupName: '/aws/lambda/heediq-ledger',
      retention: logRetentionFor(props.workloadEnv),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda — Claude API ledger worker (D-148/D-139) ───────────────────────
    // Actual implementation deployed by heediq-ledger CI. Placeholder code replaced on first
    // deploy from that repo, mirroring heediq-chat / heediq-worker-summarization.
    const ledgerFn = new lambda.Function(this, 'LedgerFn', {
      functionName: 'heediq-ledger',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      // Placeholder — real code deployed by heediq-ledger CI (D-043, D-050)
      code: lambda.Code.fromInline(
        'exports.handler = async () => { console.log("placeholder"); };',
      ),
      memorySize: COMPUTE.lambda.ledger.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.ledger.timeoutSecs),
      tracing: lambda.Tracing.ACTIVE, // D-085 — X-Ray active tracing, no separate observability tool
      logGroup: ledgerLogGroup, // D-093 — explicit retention, no unbounded log storage
      environment: {
        // Reconciliation reads the Context + this source's kept extracted items and read-writes
        // the ledger it maintains (D-148).
        CONTEXTS_TABLE_NAME:        foundation.contextsTable.tableName,
        EXTRACTED_ITEMS_TABLE_NAME: foundation.extractedItemsTable.tableName,
        DECISION_LEDGER_TABLE_NAME: foundation.decisionLedgerTable.tableName,
        CLAUDE_SECRET_NAME:         '/heediq/ledger/anthropic-api-key',
        // WS push (D-109/D-139) — direct-call pusher for ledger_ready. Like heediq-chat, this is a
        // separate Lambda/repo from heediq-api, so it carries its own PostToConnection call and
        // needs the connections table name directly to query by-user for target connectionIds;
        // grantPush() below only grants IAM, not this env var.
        WS_MANAGEMENT_ENDPOINT:     webSocket.wsManagementEndpoint,
        WS_CONNECTIONS_TABLE_NAME:  foundation.wsConnectionsTable.tableName,
      },
    });

    // ── SQS → Lambda event source (mirrors D-065 summarization worker) ────────
    // batchSize=1: each Claude API call is a separate invocation — no partial-batch failures
    // to reason about; reportBatchItemFailures returns the message to the queue on error.
    ledgerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(this.ledgerQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // ── IAM grants — least privilege (D-038) ─────────────────────────────────

    // DynamoDB — read-only inputs (Context metadata + this source's kept items).
    foundation.contextsTable.grantReadData(ledgerFn);
    foundation.extractedItemsTable.grantReadData(ledgerFn);

    // DynamoDB — the ledger this worker maintains: read existing entries, write reconciled ones.
    foundation.decisionLedgerTable.grantReadWriteData(ledgerFn);

    // WS push — table read/write + execute-api:ManageConnections (D-109)
    webSocket.grantPush(ledgerFn);

    // Secrets Manager — Claude API key fetched at cold start via direct SDK call, cached at module scope (D-100)
    ledgerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/heediq/ledger/*`,
        ],
      }),
    );

    // ── SSM params (D-038) ────────────────────────────────────────────────────
    // Consumed by heediq-ledger CI (queue target) and heediq-api (enqueue producer).

    new ssm.StringParameter(this, 'LedgerQueueUrlParam', {
      parameterName: '/heediq/ledger/queue-url',
      stringValue: this.ledgerQueue.queueUrl,
      description: 'SQS ledger queue URL — enqueue target for review-time reconciliation jobs',
    });

    new ssm.StringParameter(this, 'LedgerQueueArnParam', {
      parameterName: '/heediq/ledger/queue-arn',
      stringValue: this.ledgerQueue.queueArn,
      description: 'SQS ledger queue ARN',
    });

    new ssm.StringParameter(this, 'LedgerLambdaArnParam', {
      parameterName: '/heediq/infra/ledger-lambda-arn',
      stringValue: ledgerFn.functionArn,
      description: 'Ledger Lambda ARN — consumed by future orchestration',
    });
  }
}
