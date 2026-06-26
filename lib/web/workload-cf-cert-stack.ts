import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DOMAINS } from '../config';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WorkloadCfCertStackProps extends cdk.StackProps {}

/**
 * ACM wildcard cert in us-east-1 for CloudFront custom domains (D-053).
 *
 * CloudFront requires certs in us-east-1 regardless of the distribution's origin region.
 * This stack is deployed to us-east-1 of each workload account (dev/staging/prod).
 *
 * DNS validation uses CertificateValidation.fromDns() with NO hosted zone argument —
 * the Route 53 hosted zone is in the shared-services account which this stack can't
 * reference directly. The validation CNAME must be added manually to Route 53 in
 * shared-services on first deploy for each environment (one-time; ACM auto-renews).
 * See heediq-infra/README.md → "Setting up a new environment from scratch", Step 3.
 *
 * The cert ARN is passed as a CDK prop to WebStack via crossRegionReferences (SSM-backed
 * cross-region parameter exchange between us-east-1 and eu-west-1).
 */
export class WorkloadCfCertStack extends cdk.Stack {
  readonly cfCert: acm.Certificate;

  constructor(scope: Construct, id: string, props: WorkloadCfCertStackProps = {}) {
    super(scope, id, props);

    this.cfCert = new acm.Certificate(this, 'CloudFrontCert', {
      domainName: `*.${DOMAINS.root}`,
      subjectAlternativeNames: [DOMAINS.root],
      // No hosted zone arg — Route 53 is in shared-services account.
      // Cert stays PENDING_VALIDATION until the CNAME is added manually (see README).
      validation: acm.CertificateValidation.fromDns(),
    });

    // Stored in us-east-1 SSM — useful for manual reference / future automation.
    // CloudFront cert is passed directly as CDK prop (crossRegionReferences), not via SSM.
    new ssm.StringParameter(this, 'CfCertArnParam', {
      parameterName: '/heediq/infra/cert-arn-us-east-1',
      stringValue: this.cfCert.certificateArn,
      description: 'ACM wildcard cert ARN (us-east-1) — CloudFront custom domains (D-053)',
    });

    new cdk.CfnOutput(this, 'CloudFrontCertArn', {
      value: this.cfCert.certificateArn,
      description: 'ACM wildcard cert (us-east-1) for CloudFront',
    });
  }
}
