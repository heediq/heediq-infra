import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WorkloadEnv } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';

export interface TranscriptionStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
}

export class TranscriptionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TranscriptionStackProps) {
    super(scope, id, props);

    // TODO: ECS cluster — heediq-transcription

    // TODO: Task definitions — two variants (D-005, D-055):
    //   free-tier:  1 vCPU (cpu:1024), 2 GB (memoryMiB:2048) — whisper small, CPU
    //   paid-tier:  4 vCPU (cpu:4096), 8 GB (memoryMiB:8192) — whisper large-v3 + pyannote, CPU
    //   Container image: pulled from ECR in shared-services account (313828097088)
    //   Fargate Spot capacity provider; no idle containers (D-023)

    // TODO: EventBridge Pipe — SQS heediq-transcription → ECS RunTask Fargate Spot (D-023)
    //   Message attribute on SQS determines free vs paid task definition
    //   Job status (queued/transcribing/diarizing/done/error) written to heediq-jobs DynamoDB table

    // TODO: IAM execution role
    //   Read from heediq-audio-uploads S3 bucket
    //   Write to heediq-jobs and heediq-recordings DynamoDB tables
    //   ECR image pull (cross-account, shared-services account 313828097088)

    // TODO: CloudWatch log group — /heediq/transcription (structured logs, no PII)
  }
}
