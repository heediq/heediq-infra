import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WorkloadEnv } from '../config';

export interface FoundationStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
}

export class FoundationStack extends cdk.Stack {
  readonly workloadEnv: WorkloadEnv;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    this.workloadEnv = props.workloadEnv;

    // TODO: DynamoDB tables — PAY_PER_REQUEST in all envs (D-055, D-031)
    //   heediq-recordings  (PK: orgId, SK: recordingId)
    //   heediq-orgs        (PK: orgId)
    //   heediq-users       (PK: userId, GSI: orgId)
    //   heediq-jobs        (transcription job status; PK: jobId)

    // TODO: S3 buckets
    //   heediq-audio-uploads  — presigned URL direct upload, S3 event → SQS (D-023)
    //   heediq-web-assets     — CloudFront origin for the PWA

    // TODO: SQS queues
    //   heediq-transcription  — triggers Fargate Spot RunTask via EventBridge Pipes (D-023)

    // TODO: Cognito User Pool + App Client (D-020)
    //   Email/password + Google + Microsoft (Entra) federated IdPs
    //   Email-domain match "request to join" flow (admin approval required)

    // TODO: SES sending identity (noreply@heediq.com) + DKIM/SPF/DMARC (D-054)

    // TODO: SSM params — export all resource names/ARNs (D-038)
    //   /heediq/api/recordings-table-name
    //   /heediq/api/audio-bucket-name
    //   /heediq/api/transcription-queue-url
    //   /heediq/api/cognito-user-pool-id
    //   /heediq/api/cognito-client-id
  }
}
