import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WorkloadEnv } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';

export interface ApiStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // TODO: Lambda function — Hono REST API (D-034)
    //   Runtime: Node.js 22 (D-039)
    //   Memory: 512 MB, timeout: 30s (D-055)
    //   Handler: heediq-api/dist/lambda.handler (deployed by heediq-api CI, not this stack)
    //   Env vars injected at deploy time from foundation outputs (D-038):
    //     RECORDINGS_TABLE, AUDIO_BUCKET, TRANSCRIPTION_QUEUE_URL,
    //     COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID
    //   Secrets fetched at cold start via AWS Parameters and Secrets Lambda Extension (D-038):
    //     /heediq/api/stripe-secret-key, /heediq/api/recall-api-key

    // TODO: API Gateway HTTP API — no authorizer (JWT validation in Hono middleware, D-041)
    //   Route: ANY /{proxy+} → Lambda
    //   CORS: allow origin = web domain for this env (D-052)
    //   Prefix: /api/v1/ enforced in Hono code, not in Gateway config (D-042)

    // TODO: Custom domain (D-052)
    //   api.heediq.com / api-staging.heediq.com / api-dev.heediq.com
    //   Regional ACM cert read from SSM (shared-services cross-account param, D-038/D-053)
    //   Route 53 A-alias record in shared-services hosted zone (cross-account Route 53)

    // TODO: IAM grants — least privilege on DynamoDB tables, S3 bucket, SQS queue, Secrets Manager
  }
}
