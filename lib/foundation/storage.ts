import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface FoundationStorage {
  transcriptionQueue: sqs.Queue;
  audioUploadsBucket: s3.Bucket;
  webAssetsBucket: s3.Bucket;
}

export interface FoundationStorageProps {
  removalPolicy: cdk.RemovalPolicy;
  isProd: boolean;
}

// ── SQS transcription queue + S3 audio-uploads/web-assets buckets (D-023) ──
export function createStorageAndQueues(scope: Construct, props: FoundationStorageProps): FoundationStorage {
  const { removalPolicy, isProd } = props;

  const transcriptionDlq = new sqs.Queue(scope, 'TranscriptionDlq', {
    queueName: 'heediq-transcription-dlq',
    retentionPeriod: cdk.Duration.days(14),
    enforceSSL: true,
  });

  const transcriptionQueue = new sqs.Queue(scope, 'TranscriptionQueue', {
    queueName: 'heediq-transcription',
    // Consumed by the dispatcher Lambda (D-157), which returns in ms after handing the job to
    // ECS RunTask — the message is not held for the job's duration. Visibility only needs to
    // exceed the dispatcher's 30s timeout so a failed dispatch retries (→ DLQ after 3 attempts)
    // rather than double-running. 90s gives headroom without a long retry stall.
    visibilityTimeout: cdk.Duration.seconds(90),
    deadLetterQueue: { queue: transcriptionDlq, maxReceiveCount: 3 },
    enforceSSL: true,
  });

  // Account-ID suffix keeps name globally unique while preserving D-037 spirit
  // (see infra README Gotchas — S3 global namespace)
  const audioUploadsBucket = new s3.Bucket(scope, 'AudioUploadsBucket', {
    bucketName: `heediq-audio-uploads-${cdk.Aws.ACCOUNT_ID}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    cors: [
      {
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedOrigins: [
          'https://heediq.com',
          'https://staging.heediq.com',
          'https://dev.heediq.com',
          'http://localhost:5173',
        ],
        allowedHeaders: ['*'],
        maxAge: 3600,
      },
    ],
    lifecycleRules: [
      {
        // Paid-tier archival safety net (D-022); free-tier 30-day deletion handled by app
        id: 'archive-to-glacier-deep',
        transitions: [
          {
            storageClass: s3.StorageClass.DEEP_ARCHIVE,
            transitionAfter: cdk.Duration.days(90),
          },
        ],
      },
      {
        id: 'abort-incomplete-multipart',
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      },
    ],
    removalPolicy,
    autoDeleteObjects: !isProd,
  });

  // CloudFront origin; WebStack OAC
  const webAssetsBucket = new s3.Bucket(scope, 'WebAssetsBucket', {
    bucketName: `heediq-web-assets-${cdk.Aws.ACCOUNT_ID}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    removalPolicy,
    autoDeleteObjects: !isProd,
  });

  // Grant CloudFront OAC read access. Source-account condition avoids a circular CDK
  // dependency: WebStack can't add bucket policy from outside this stack without
  // exporting the distribution ARN back here (Foundation → WebStack ← Foundation).
  // One distribution per workload account makes the source-account scope acceptable.
  webAssetsBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'AllowCloudFrontOAC',
    actions: ['s3:GetObject'],
    principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
    resources: [webAssetsBucket.arnForObjects('*')],
    conditions: {
      StringEquals: { 'AWS:SourceAccount': cdk.Stack.of(scope).account },
    },
  }));

  return { transcriptionQueue, audioUploadsBucket, webAssetsBucket };
}
