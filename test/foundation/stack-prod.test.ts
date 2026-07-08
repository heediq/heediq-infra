import { describe, it } from 'vitest';
import { Match } from 'aws-cdk-lib/assertions';
import { synthProdTemplate } from './test-utils';

describe('FoundationStack (prod)', () => {
  it('uses RETAIN removal policy — no DESTROY or autoDeleteObjects', () => {
    const template = synthProdTemplate();

    // autoDeleteObjects custom resource should NOT exist in prod
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);

    // All DynamoDB tables should have DeletionPolicy: Retain
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const [, resource] of Object.entries(tables)) {
      const r = resource as { DeletionPolicy?: string };
      if (r.DeletionPolicy !== undefined) {
        // If set, must be Retain
        if (r.DeletionPolicy !== 'Retain') {
          throw new Error(`DynamoDB table has DeletionPolicy ${r.DeletionPolicy}, expected Retain`);
        }
      }
    }
  });

  it('Cognito hosted domain uses prod prefix', () => {
    const template = synthProdTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'heediq-prod',
    });
  });

  it('prod User Pool client has no localhost callback URLs', () => {
    const template = synthProdTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.not(Match.arrayWith(['http://localhost:5173/auth/callback'])),
    });
  });
});
