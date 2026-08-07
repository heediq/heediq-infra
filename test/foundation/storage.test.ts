import { describe, it, beforeAll, expect } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthDevTemplate } from './test-utils';

describe('FoundationStack — SQS & S3 (dev)', () => {
  let template: Template;

  beforeAll(() => {
    template = synthDevTemplate();
  });

  it('creates transcription queue with a 90s visibility timeout (> dispatcher Lambda timeout, D-157) and DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-transcription',
      VisibilityTimeout: 90,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('creates transcription DLQ with 14-day retention', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-transcription-dlq',
      MessageRetentionPeriod: 1209600, // 14 days in seconds
    });
  });

  it('creates 2 S3 buckets, both blocking public access', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('audio uploads bucket has CORS and Glacier lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: Match.objectLike({
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: Match.arrayWith(['PUT']),
            AllowedOrigins: Match.arrayWith(['http://localhost:5173']),
          }),
        ]),
      }),
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({ Id: 'archive-to-glacier-deep' }),
          Match.objectLike({ Id: 'abort-incomplete-multipart' }),
        ]),
      }),
    });
  });

  it('audio bucket has no S3→SQS notification — ingestion is API-driven, not bucket-event-driven (D-157)', () => {
    // The pre-D-023 S3 OBJECT_CREATED → transcription-queue notification was removed: audio jobs
    // are enqueued by the API after upload, never by a raw bucket event. No S3-principal grant
    // should remain on the queue.
    const queuePolicies = template.findResources('AWS::SQS::QueuePolicy');
    const statements = Object.values(queuePolicies).flatMap(
      (p) => p.Properties?.PolicyDocument?.Statement ?? [],
    );
    const s3Grants = statements.filter(
      (s: { Principal?: { Service?: unknown } }) => s.Principal?.Service === 's3.amazonaws.com',
    );
    expect(s3Grants).toHaveLength(0);
  });

  it('web-assets bucket policy allows cloudfront.amazonaws.com with source-account condition (OAC)', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudFrontOAC',
            Action: 's3:GetObject',
            Principal: Match.objectLike({ Service: 'cloudfront.amazonaws.com' }),
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({ 'AWS:SourceAccount': Match.anyValue() }),
            }),
          }),
        ]),
      }),
    });
  });
});
