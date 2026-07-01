import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { WorkloadEnv, COMPUTE } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';

export interface SummarizationStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
}

export class SummarizationStack extends cdk.Stack {
  // Exported for potential future cross-stack use (e.g. additional producers)
  readonly summarizationQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: SummarizationStackProps) {
    super(scope, id, props);

    const { foundation } = props;

    // ── SQS — source-agnostic summarization queue (D-065) ────────────────────
    // Single entry point for ALL content sources: transcription worker (audio)
    // and API Lambda (text files, PDFs, emails, Excel, etc. — D-026).
    // Message payload: { sourceType, contentRef (S3 path), recordingId, orgId, ... }

    const dlq = new sqs.Queue(this, 'SummarizationDlq', {
      queueName: 'heediq-summarization-dlq',
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.summarizationQueue = new sqs.Queue(this, 'SummarizationQueue', {
      queueName: 'heediq-summarization',
      // Visibility timeout must exceed Lambda timeout (300s) to avoid re-processing
      // a message while the Lambda is still running. 360s = timeout + 60s buffer.
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });

    // ── Lambda — Claude API extraction worker (D-032, D-055) ─────────────────
    // Actual implementation deployed by heediq-worker-summarization CI (D-043, D-050).
    // Placeholder code replaced on first deploy from that repo.
    const summarizationFn = new lambda.Function(this, 'SummarizationFn', {
      functionName: 'heediq-summarization',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      // Placeholder — real code deployed by heediq-worker-summarization CI (D-043, D-050)
      code: lambda.Code.fromInline(
        'exports.handler = async () => { console.log("placeholder"); };',
      ),
      memorySize: COMPUTE.lambda.summarization.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.summarization.timeoutSecs),
      environment: {
        JOBS_TABLE_NAME:       foundation.jobsTable.tableName,
        RECORDINGS_TABLE_NAME: foundation.recordingsTable.tableName,
        AUDIO_BUCKET_NAME:     foundation.audioUploadsBucket.bucketName,
        CLAUDE_SECRET_NAME:    '/heediq/summarization/anthropic-api-key',
      },
    });

    // ── SQS → Lambda event source (D-065) ─────────────────────────────────────
    // batchSize=1: each Claude API call is a separate invocation — no partial-batch
    // failures to reason about; bisectOnError is good practice regardless.
    // batchSize=1: each Claude API call is a separate invocation — no partial batches.
    // reportBatchItemFailures: on Lambda error, message returns to queue rather than
    // poisoning the whole batch (harmless with batchSize=1 but good practice).
    summarizationFn.addEventSource(
      new lambdaEventSources.SqsEventSource(this.summarizationQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // ── IAM grants — least privilege (D-038) ─────────────────────────────────

    // DynamoDB — read job details; write status (summarizing → done/failed)
    foundation.jobsTable.grantReadWriteData(summarizationFn);

    // DynamoDB — write structured extraction output (requirements, decisions, etc.)
    foundation.recordingsTable.grantReadWriteData(summarizationFn);

    // S3 — read transcript/content files written by transcription worker or uploaded
    // directly (text files, PDFs, emails, Excel — D-065, D-026)
    foundation.audioUploadsBucket.grantRead(summarizationFn);

    // Secrets Manager — Claude API key fetched at cold start via Lambda Extension (D-038)
    summarizationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/heediq/summarization/*`,
        ],
      }),
    );

    // ── SSM params (D-038) ────────────────────────────────────────────────────
    // Consumed by heediq-worker-summarization CI (queue target) and future orchestration.

    new ssm.StringParameter(this, 'SummarizationQueueUrlParam', {
      parameterName: '/heediq/summarization/queue-url',
      stringValue: this.summarizationQueue.queueUrl,
      description: 'SQS summarization queue URL — enqueue target for all content sources',
    });

    new ssm.StringParameter(this, 'SummarizationQueueArnParam', {
      parameterName: '/heediq/summarization/queue-arn',
      stringValue: this.summarizationQueue.queueArn,
      description: 'SQS summarization queue ARN',
    });

    new ssm.StringParameter(this, 'SummarizationLambdaArnParam', {
      parameterName: '/heediq/infra/summarization-lambda-arn',
      stringValue: summarizationFn.functionArn,
      description: 'Summarization Lambda ARN — consumed by future orchestration',
    });
  }
}
