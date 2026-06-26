import { describe, it, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { WebStack } from '../lib/web/web-stack';

function buildTemplates(workloadEnv: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const account = workloadEnv === 'prod' ? '438825592314' : '123456789012';
  const env = { account, region: 'eu-west-1' };

  const foundation = new FoundationStack(app, 'TestFoundationStack', {
    env,
    workloadEnv,
  });

  // Simulate the cert from WorkloadCfCertStack (us-east-1) via fromCertificateArn.
  // In production it's a CDK prop passed via crossRegionReferences; in tests we mock it.
  const cfCert = acm.Certificate.fromCertificateArn(
    foundation,
    'MockCfCert',
    `arn:aws:acm:us-east-1:${account}:certificate/mock-cf-cert`,
  );

  const web = new WebStack(app, 'TestWebStack', {
    env,
    workloadEnv,
    crossRegionReferences: true,
    foundation,
    cfCert,
  });

  return {
    web: Template.fromStack(web),
  };
}

describe('WebStack (dev)', () => {
  let web: Template;

  beforeAll(() => {
    ({ web } = buildTemplates('dev'));
  });

  // ── CloudFront distribution ────────────────────────────────────────────────

  it('creates a CloudFront distribution', () => {
    web.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('distribution uses PriceClass_100 (US + EU, D-055)', () => {
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_100',
      }),
    });
  });

  it('distribution has index.html as default root object', () => {
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
      }),
    });
  });

  it('distribution supports HTTP2 and HTTP3', () => {
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        HttpVersion: 'http2and3',
      }),
    });
  });

  it('distribution redirects HTTP to HTTPS', () => {
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });

  it('distribution uses dev.heediq.com as custom domain', () => {
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['dev.heediq.com'],
      }),
    });
  });

  // ── SPA error responses ────────────────────────────────────────────────────

  it('403 from S3 returns /index.html with 200 (SPA routing)', () => {
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      }),
    });
  });

  it('404 from S3 returns /index.html with 200 (SPA routing)', () => {
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      }),
    });
  });

  // ── Security headers ───────────────────────────────────────────────────────

  it('creates a ResponseHeadersPolicy with HSTS enabled', () => {
    web.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            AccessControlMaxAgeSec: 31536000,
            IncludeSubdomains: true,
            Override: true,
          }),
        }),
      }),
    });
  });

  it('response headers policy denies framing (X-Frame-Options: DENY)', () => {
    web.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          FrameOptions: Match.objectLike({
            FrameOption: 'DENY',
            Override: true,
          }),
        }),
      }),
    });
  });

  it('response headers policy sets X-Content-Type-Options nosniff', () => {
    web.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentTypeOptions: Match.objectLike({ Override: true }),
        }),
      }),
    });
  });

  // ── OAC ───────────────────────────────────────────────────────────────────

  it('creates an S3 Origin Access Control', () => {
    web.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('OAC uses SIGV4 signing and applies to S3 origin type', () => {
    web.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        SigningBehavior: 'no-override',
        SigningProtocol: 'sigv4',
        OriginAccessControlOriginType: 's3',
      }),
    });
  });

  // ── Route 53 alias record ─────────────────────────────────────────────────

  it('creates Route53AliasRecord custom resource for dev.heediq.com', () => {
    web.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      RecordName: 'dev.heediq.com',
      HostedZoneId: 'Z0875312RP7WHSNW7AUM',
    });
  });

  it('Route53AliasRecord uses CloudFront hosted zone ID Z2FDTNDATAQYW2', () => {
    web.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      TargetHostedZoneId: 'Z2FDTNDATAQYW2',
    });
  });

  it('Route53AliasRecord handler role has sts:AssumeRole on heediq-route53-dns-manager', () => {
    web.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Resource: 'arn:aws:iam::313828097088:role/heediq-route53-dns-manager',
          }),
        ]),
      }),
    });
  });

  // ── SSM params ────────────────────────────────────────────────────────────

  it('exports /heediq/web/url SSM param', () => {
    web.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/web/url',
      Value: 'https://dev.heediq.com',
    });
  });

  it('exports /heediq/web/cloudfront-distribution-id SSM param', () => {
    web.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/web/cloudfront-distribution-id',
    });
  });

  // ── CfnOutputs ────────────────────────────────────────────────────────────

  it('emits DistributionId and DistributionDomainName outputs', () => {
    web.hasOutput('DistributionId', {});
    web.hasOutput('DistributionDomainName', {});
  });
});

describe('WebStack (prod)', () => {
  it('uses heediq.com as the custom domain (apex domain)', () => {
    const { web } = buildTemplates('prod');
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['heediq.com'],
      }),
    });
    web.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/web/url',
      Value: 'https://heediq.com',
    });
  });

  it('prod Route53AliasRecord targets heediq.com (apex)', () => {
    const { web } = buildTemplates('prod');
    web.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      RecordName: 'heediq.com',
      HostedZoneId: 'Z0875312RP7WHSNW7AUM',
    });
  });
});
