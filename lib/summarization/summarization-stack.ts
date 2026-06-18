import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WorkloadEnv } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';

export interface SummarizationStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
}

export class SummarizationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SummarizationStackProps) {
    super(scope, id, props);

    // TODO: Lambda function — Claude API extraction worker (D-032)
    //   Runtime: Node.js 22 (D-039)
    //   Memory: 512 MB, timeout: 5 min / 300s (D-055)
    //   Implemented behind a provider interface so model/vendor is swappable (D-032)
    //   Claude API key loaded at cold start via AWS Parameters and Secrets Lambda Extension (D-038)
    //     /heediq/summarization/claude-api-key

    // TODO: Trigger — EventBridge rule on transcription-complete event (written by transcription worker)
    //   Or SQS queue if fan-out is needed (TBD at implementation)

    // TODO: Output — structured extraction (requirements, decisions, open questions, summary)
    //   Written to heediq-recordings DynamoDB table (D-033 consistent response shape)

    // TODO: IAM policy
    //   Read from heediq-recordings and heediq-jobs tables
    //   Write to heediq-recordings table (summary fields)
    //   Secrets Manager read for /heediq/summarization/claude-api-key
  }
}
