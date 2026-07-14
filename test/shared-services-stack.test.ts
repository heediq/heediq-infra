import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SharedServicesStack } from '../lib/shared-services/shared-services-stack';

describe('SharedServicesStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new SharedServicesStack(app, 'TestSharedServicesStack', {
      env: { account: '313828097088', region: 'eu-west-1' },
    });
    template = Template.fromStack(stack);
  });

  // ── ECR ────────────────────────────────────────────────────────────────────

  it('creates ECR repo named heediq-worker-transcription', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'heediq-worker-transcription',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  it('ECR lifecycle rule prefixes match the tags CI actually pushes (D-101, count per D-108)', () => {
    // deploy.yml pushes free-sha-<7chars> / paid-sha-<7chars> — regression guard for the
    // D-101 bug where tagPrefixList: ['sha-'] never matched either tag, so nothing expired.
    // Keep-count is 3/tier per D-108 (current + 1 rollback covers dev+staging+prod mid-promotion).
    template.hasResourceProperties('AWS::ECR::Repository', {
      LifecyclePolicy: Match.objectLike({
        LifecyclePolicyText: Match.serializedJson(
          Match.objectLike({
            rules: Match.arrayWith([
              Match.objectLike({
                selection: Match.objectLike({
                  tagPrefixList: ['free-sha-'],
                  countNumber: 3,
                }),
              }),
              Match.objectLike({
                selection: Match.objectLike({
                  tagPrefixList: ['paid-sha-'],
                  countNumber: 3,
                }),
              }),
            ]),
          }),
        ),
      }),
    });
  });

  it('ECR repo policy has AllowWorkloadAccountPull statement', () => {
    // CDK renders AccountPrincipal as Fn::Join tokens — check Sid only; account IDs
    // are constants and the trust boundary is enforced by the stack env.
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryPolicyText: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'AllowWorkloadAccountPull' }),
        ]),
      }),
    });
  });

  // ── Route 53 ───────────────────────────────────────────────────────────────

  it('creates Route 53 hosted zone for heediq.com', () => {
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'heediq.com.',
    });
  });

  // ── SES (D-058) ────────────────────────────────────────────────────────────

  it('creates SES email identity for heediq.com with DKIM signing', () => {
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'heediq.com',
      DkimAttributes: { SigningEnabled: true },
    });
  });

  it('creates 3 DKIM CNAME records in Route 53', () => {
    const cnames = template.findResources('AWS::Route53::RecordSet', {
      Properties: { Type: 'CNAME', TTL: '3600' },
    });
    expect(Object.keys(cnames).length).toBe(3);
  });

  it('creates SES email sending IAM role with 3 workload-account trust statements', () => {
    // CompositePrincipal(AccountPrincipal×3) → one sts:AssumeRole statement per account.
    // CDK renders each account ARN as Fn::Join — check the count, not raw ARN strings.
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'heediq-ses-email-sending',
    });
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'heediq-ses-email-sending' },
    });
    const statements = Object.values(roles)[0].Properties.AssumeRolePolicyDocument.Statement;
    expect(statements.length).toBe(3);
  });

  it('SES sending role policy scoped to heediq.com identity only', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ses:SendEmail', 'ses:SendRawEmail']),
            Resource: Match.stringLikeRegexp('identity/heediq.com'),
          }),
        ]),
      }),
    });
  });

  // ── Route 53 DNS manager role ──────────────────────────────────────────────

  it('creates heediq-route53-dns-manager role trusted by all 3 workload accounts', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'heediq-route53-dns-manager',
    });
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'heediq-route53-dns-manager' },
    });
    const statements = Object.values(roles)[0].Properties.AssumeRolePolicyDocument.Statement;
    expect(statements.length).toBe(3);
  });

  it('DNS manager role policy allows ChangeResourceRecordSets + GetChange on the hosted zone', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'route53:ChangeResourceRecordSets',
              'route53:GetChange',
            ]),
          }),
        ]),
      }),
    });
  });

  it('exports DNS manager role ARN to SSM /heediq/shared/route53-dns-manager-role-arn', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/shared/route53-dns-manager-role-arn',
    });
  });

  // ── ACM ────────────────────────────────────────────────────────────────────

  it('creates ACM wildcard certificate for heediq.com', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'heediq.com',
      SubjectAlternativeNames: ['*.heediq.com'],
    });
  });
});
