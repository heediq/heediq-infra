import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class SharedServicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // TODO: ECR repositories — one per container image (heediq-worker-transcription)

    // TODO: Route 53 public hosted zone for heediq.com (D-051)

    // TODO: ACM wildcard cert in eu-west-1 for API Gateway (D-053)
    //   Covers: heediq.com + *.heediq.com
    //   DNS validation via Route 53 hosted zone above

    // TODO: ACM wildcard cert in us-east-1 for CloudFront (D-053)
    //   Must be a cross-region resource (cdk.aws_certificatemanager via us-east-1 env)
    //   Covers: heediq.com + *.heediq.com

    // TODO: Output cert ARNs + hosted zone ID to SSM params for cross-account lookup (D-038)
    //   /heediq/shared/hosted-zone-id
    //   /heediq/shared/cert-arn-eu-west-1
    //   /heediq/shared/cert-arn-us-east-1
  }
}
