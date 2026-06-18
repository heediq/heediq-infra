import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WorkloadEnv } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';

export interface WebStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    // TODO: CloudFront distribution
    //   Origin: S3 bucket heediq-web-assets (OAC — not legacy OAI)
    //   Price class: PriceClass_100 (US + EU, D-055)
    //   ACM cert (us-east-1 wildcard) read from SSM cross-account param (D-053)
    //   Default root object: index.html
    //   Custom error responses: 404 + 403 → /index.html 200 (SPA client-side routing)
    //   Response headers policy: CSP, HSTS, X-Frame-Options, X-Content-Type-Options

    // TODO: Custom domain (D-052)
    //   prod: heediq.com / staging: staging.heediq.com / dev: dev.heediq.com
    //   Route 53 A-alias record in shared-services hosted zone (cross-account)

    // Note: static asset deployment (S3 sync of heediq-web/dist/) is handled by heediq-web CI,
    // not this CDK stack. This stack provisions the CloudFront + S3 infrastructure only.
  }
}
