import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ACCOUNTS, AWS_REGION, DOMAINS, EMAIL } from '../config';

export class SharedServicesStack extends cdk.Stack {
  readonly hostedZone: route53.PublicHostedZone;
  readonly certEuWest1: acm.Certificate;
  readonly transcriptionRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // ── ECR — transcription worker image registry ──────────────────────────────
    // Build once in shared-services, pull into dev/staging/prod by image tag (D-047).

    this.transcriptionRepo = new ecr.Repository(this, 'TranscriptionRepo', {
      repositoryName: 'heediq-worker-transcription',
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: 'Remove untagged layers after 1 day',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(1),
        },
        {
          description: 'Keep last 20 sha-tagged images',
          tagStatus: ecr.TagStatus.TAGGED,
          tagPrefixList: ['sha-'],  // D-047: images tagged sha-<7chars>
          maxImageCount: 20,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Allow workload accounts to pull images (push is via GitHubActionsDeployRole in same account)
    this.transcriptionRepo.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowWorkloadAccountPull',
      principals: [
        new iam.AccountPrincipal(ACCOUNTS.dev),
        new iam.AccountPrincipal(ACCOUNTS.staging),
        new iam.AccountPrincipal(ACCOUNTS.prod),
      ],
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
      ],
    }));

    // ── Route 53 — primary hosted zone (D-051) ────────────────────────────────
    // After first deploy, update NS records at domain registrar using NameServers output.

    this.hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: DOMAINS.root,
      comment: 'heediq.com primary hosted zone — D-051',
    });
    // Never delete: removing a hosted zone breaks all DNS; must be done manually if ever needed
    (this.hostedZone.node.defaultChild as cdk.CfnResource)
      .applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // ── Email — Zoho EU DNS records ───────────────────────────────────────────

    new route53.MxRecord(this, 'EmailMx', {
      zone: this.hostedZone,
      values: [
        { hostName: 'mx.zoho.eu.', priority: 10 },
        { hostName: 'mx2.zoho.eu.', priority: 20 },
        { hostName: 'mx3.zoho.eu.', priority: 50 },
      ],
      ttl: cdk.Duration.hours(1),
    });

    new route53.TxtRecord(this, 'EmailSpf', {
      zone: this.hostedZone,
      values: ['v=spf1 include:zoho.eu ~all'],
      ttl: cdk.Duration.hours(1),
    });

    new route53.TxtRecord(this, 'EmailDmarc', {
      zone: this.hostedZone,
      recordName: '_dmarc',
      values: ['v=DMARC1; p=none; rua=mailto:dmarc@heediq.com'],
      ttl: cdk.Duration.hours(1),
    });

    if (EMAIL.zohoDkimKey) {
      new route53.TxtRecord(this, 'EmailDkim', {
        zone: this.hostedZone,
        recordName: 'zoho._domainkey',
        values: [EMAIL.zohoDkimKey],
        ttl: cdk.Duration.hours(1),
      });
    }

    // ── SES — heediq.com domain identity (D-058) ─────────────────────────────
    // Identity lives here alongside Route 53 so DKIM CNAMEs can be created in
    // the same stack with no cross-account dependencies. Workload Lambdas send
    // email by assuming heediq-ses-email-sending role in this account (D-058).

    const sesIdentity = new ses.CfnEmailIdentity(this, 'SesEmailIdentity', {
      emailIdentity: DOMAINS.root,
      dkimAttributes: { signingEnabled: true },
    });

    // CNAME records wired in the same stack — attrDkimDnsTokenNameN is the full
    // FQDN (e.g. xxx._domainkey.heediq.com); CfnRecordSet accepts full FQDNs.
    for (let i = 1; i <= 3; i++) {
      const name  = (sesIdentity as any)[`attrDkimDnsTokenName${i}`]  as string;
      const value = (sesIdentity as any)[`attrDkimDnsTokenValue${i}`] as string;
      new route53.CfnRecordSet(this, `SesDkimCname${i}`, {
        hostedZoneId: this.hostedZone.hostedZoneId,
        name,
        type: 'CNAME',
        ttl: '3600',
        resourceRecords: [value],
      });
    }

    // Cross-account IAM role — workload Lambdas assume this to send from noreply@heediq.com
    const sesEmailSendingRole = new iam.Role(this, 'SesEmailSendingRole', {
      roleName: 'heediq-ses-email-sending',
      assumedBy: new iam.CompositePrincipal(
        new iam.AccountPrincipal(ACCOUNTS.dev),
        new iam.AccountPrincipal(ACCOUNTS.staging),
        new iam.AccountPrincipal(ACCOUNTS.prod),
      ),
    });
    sesEmailSendingRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail', 'ses:SendTemplatedEmail'],
      resources: [`arn:aws:ses:${AWS_REGION}:${this.account}:identity/${DOMAINS.root}`],
    }));

    new cdk.CfnOutput(this, 'SesEmailSendingRoleArn', {
      value: sesEmailSendingRole.roleArn,
      description: 'IAM role assumed by workload Lambdas for cross-account SES sending (D-058)',
    });

    // ── ACM — wildcard cert eu-west-1 for API Gateway (D-053) ─────────────────

    this.certEuWest1 = new acm.Certificate(this, 'WildcardCertEuWest1', {
      domainName: DOMAINS.root,
      subjectAlternativeNames: [`*.${DOMAINS.root}`],
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });
    // Note: validation will stay PENDING until NS records are updated at registrar

    // ── SSM params — for audit; workload stacks read from config.ts after first deploy ──

    new ssm.StringParameter(this, 'HostedZoneIdParam', {
      parameterName: '/heediq/shared/hosted-zone-id',
      stringValue: this.hostedZone.hostedZoneId,
      description: 'Route 53 hosted zone ID for heediq.com',
    });

    // ── Outputs — capture these after first deploy ─────────────────────────────

    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(', ', this.hostedZone.hostedZoneNameServers!),
      description: 'ACTION REQUIRED: update these NS records at your domain registrar',
    });

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Add to config.ts SHARED_SERVICES.hostedZoneId',
    });

    new cdk.CfnOutput(this, 'CertArnEuWest1', {
      value: this.certEuWest1.certificateArn,
      description: 'ACM wildcard cert (eu-west-1) — stored in config.ts SHARED_SERVICES.certArnEuWest1',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: this.transcriptionRepo.repositoryUri,
      description: 'ECR URI for heediq-worker-transcription — use in ECS task definitions',
    });
  }
}
