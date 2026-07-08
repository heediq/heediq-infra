import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DOMAINS } from '../config';

// ── ACM wildcard cert (eu-west-1) — API Gateway + WebSocket custom domains (D-053, D-063) ──
// Cert must live in this workload account — API Gateway rejects cross-account certs.
// IMPORTANT: ACM generates a unique validation CNAME per cert request (not per domain).
// On FIRST deploy for each new environment, the CNAME for THIS cert must be manually added
// to Route 53 in the shared-services account. See heediq-infra/README.md → Domains section.
// ACM auto-renews using the same CNAME — the manual step is truly one-time per cert.
export function createWildcardCert(scope: Construct): acm.Certificate {
  const wildcardCert = new acm.Certificate(scope, 'WildcardCert', {
    domainName: `*.${DOMAINS.root}`,
    subjectAlternativeNames: [DOMAINS.root],
    validation: acm.CertificateValidation.fromDns(),
  });

  new ssm.StringParameter(scope, 'WildcardCertArnParam', {
    parameterName: '/heediq/infra/cert-arn-eu-west-1',
    stringValue: wildcardCert.certificateArn,
    description: 'ACM wildcard cert ARN (eu-west-1) — API Gateway and WebSocket custom domains',
  });

  new cdk.CfnOutput(scope, 'WildcardCertArn', {
    value: wildcardCert.certificateArn,
    description: 'ACM wildcard cert (eu-west-1) for API Gateway and WebSocket custom domains',
  });

  return wildcardCert;
}
