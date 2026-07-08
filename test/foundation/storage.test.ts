import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthDevTemplate } from './test-utils';

describe('FoundationStack — SQS & S3 (dev)', () => {
  let template: Template;

  beforeAll(() => {
    template = synthDevTemplate();
  });

  it('creates transcription queue with 1h visibility timeout and DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'heediq-transcription',
      VisibilityTimeout: 3600,
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

  it('audio bucket SQS notification — queue policy allows s3.amazonaws.com to send', () => {
    // CDK wires S3→SQS via a Lambda-backed custom resource; the verifiable contract is
    // the SQS queue policy granting s3.amazonaws.com SendMessage access.
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:SendMessage']),
            Principal: Match.objectLike({ Service: 's3.amazonaws.com' }),
          }),
        ]),
      }),
    });
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
