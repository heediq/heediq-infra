import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { DOMAINS } from '../config';

export interface SharedServicesCfCertStackProps extends cdk.StackProps {
  hostedZone: route53.PublicHostedZone;
}

export class SharedServicesCfCertStack extends cdk.Stack {
  readonly certUsEast1: acm.Certificate;

  constructor(scope: Construct, id: string, props: SharedServicesCfCertStackProps) {
    super(scope, id, props);

    // ACM wildcard cert in us-east-1 — CloudFront requires certs in this region (D-053).
    // DNS validation adds CNAME records to the Route 53 hosted zone in eu-west-1 via
    // CDK's crossRegionReferences mechanism (SSM-backed cross-region resource pass).

    this.certUsEast1 = new acm.Certificate(this, 'CloudFrontCert', {
      domainName: DOMAINS.root,
      subjectAlternativeNames: [`*.${DOMAINS.root}`],
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });
    // Note: validation will stay PENDING until NS records are updated at registrar
    // (same prerequisite as the eu-west-1 cert)

    new cdk.CfnOutput(this, 'CertArnUsEast1', {
      value: this.certUsEast1.certificateArn,
      description: 'ACM wildcard cert (us-east-1) — stored in config.ts SHARED_SERVICES.certArnUsEast1',
    });
  }
}
