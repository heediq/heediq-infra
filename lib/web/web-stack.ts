import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { WorkloadEnv, DOMAINS, SHARED_SERVICES, ACCOUNTS } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';
import { Route53AliasRecord } from '../shared/route53-alias-record';

// CloudFront's fixed hosted zone ID for A-alias records (global — same in all regions/accounts)
const CLOUDFRONT_HOSTED_ZONE_ID = 'Z2FDTNDATAQYW2';

export interface WebStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
  /** ACM wildcard cert from WorkloadCfCertStack (us-east-1) — required by CloudFront (D-053) */
  cfCert: acm.ICertificate;
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { workloadEnv, foundation, cfCert } = props;

    const webDomain = DOMAINS.web[workloadEnv];

    // Import the web-assets bucket by name rather than using the CDK prop directly.
    // This prevents CDK from trying to add a cross-stack bucket policy (which would
    // create a circular dependency: WebStack → FoundationStack for bucket ref AND
    // FoundationStack → WebStack for the distribution ARN in the OAC condition).
    // The OAC grant (source-account condition) is already in FoundationStack.
    const webAssetsBucket = s3.Bucket.fromBucketName(
      this,
      'WebAssetsBucket',
      foundation.webAssetsBucket.bucketName,
    );

    // ── CloudFront OAC ────────────────────────────────────────────────────────

    const oac = new cloudfront.S3OriginAccessControl(this, 'WebAssetsOAC', {
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(webAssetsBucket, {
      originAccessControl: oac,
    });

    // ── Response headers policy (security headers) ────────────────────────────

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'SecurityHeadersPolicy',
      {
        responseHeadersPolicyName: `heediq-security-headers-${workloadEnv}`,
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.seconds(31536000), // 1 year
            includeSubdomains: true,
            override: true,
          },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          contentTypeOptions: { override: true },
          xssProtection: { protection: true, modeBlock: true, override: true },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
        },
      },
    );

    // ── CloudFront distribution ───────────────────────────────────────────────

    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      domainNames: [webDomain],
      certificate: cfCert,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US + EU (D-055)
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
      },
      // SPA client-side routing: return index.html for 403/404 from S3
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      comment: `heediq web (${workloadEnv})`,
    });

    // ── Route 53 A-alias record (cross-account via heediq-route53-dns-manager) ─

    const dnsManagerRoleArn = `arn:aws:iam::${ACCOUNTS.sharedServices}:role/heediq-route53-dns-manager`;

    new Route53AliasRecord(this, 'WebAliasRecord', {
      recordName: webDomain,
      targetDnsName: distribution.distributionDomainName,
      targetHostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
      hostedZoneId: SHARED_SERVICES.hostedZoneId,
      dnsManagerRoleArn,
    });

    // ── SSM params ────────────────────────────────────────────────────────────

    new ssm.StringParameter(this, 'WebUrlParam', {
      parameterName: '/heediq/web/url',
      stringValue: `https://${webDomain}`,
      description: 'Web app URL — consumed by heediq-api (CORS) and heediq-web (runtime config)',
    });

    new ssm.StringParameter(this, 'CfDistributionIdParam', {
      parameterName: '/heediq/web/cloudfront-distribution-id',
      stringValue: distribution.distributionId,
      description: 'CloudFront distribution ID — used by heediq-web CI for cache invalidation',
    });

    // ── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name (e.g. d1234.cloudfront.net)',
    });
  }
}
