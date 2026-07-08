import { describe, it, beforeAll } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { synthDevTemplate } from './test-utils';

describe('FoundationStack — ACM cert (dev)', () => {
  let template: Template;

  beforeAll(() => {
    template = synthDevTemplate();
  });

  it('creates a wildcard ACM cert with DNS validation for *.heediq.com', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: '*.heediq.com',
      SubjectAlternativeNames: ['heediq.com'],
      ValidationMethod: 'DNS',
    });
  });

  it('exports wildcard cert ARN to SSM /heediq/infra/cert-arn-eu-west-1', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/infra/cert-arn-eu-west-1',
    });
  });
});
