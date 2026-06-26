import { describe, it, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { WorkloadCfCertStack } from '../lib/web/workload-cf-cert-stack';

describe('WorkloadCfCertStack (dev)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new WorkloadCfCertStack(app, 'TestWorkloadCfCertStack', {
      env: { account: '276594885933', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  it('creates ACM cert for *.heediq.com with heediq.com SAN and DNS validation (D-053)', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: '*.heediq.com',
      SubjectAlternativeNames: ['heediq.com'],
      ValidationMethod: 'DNS',
    });
  });

  it('exports cert ARN to SSM /heediq/infra/cert-arn-us-east-1', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/infra/cert-arn-us-east-1',
    });
  });

  it('emits CloudFrontCertArn CfnOutput', () => {
    template.hasOutput('CloudFrontCertArn', {});
  });

  it('creates exactly 1 certificate and 1 SSM parameter', () => {
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    template.resourceCountIs('AWS::SSM::Parameter', 1);
  });
});
