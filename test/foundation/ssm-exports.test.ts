import { describe, it, beforeAll } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { synthDevTemplate } from './test-utils';

describe('FoundationStack — SSM exports (dev)', () => {
  let template: Template;

  beforeAll(() => {
    template = synthDevTemplate();
  });

  it('exports all 19 required SSM parameters', () => {
    const expectedParams = [
      '/heediq/infra/cert-arn-eu-west-1',
      '/heediq/api/sources-table-name',
      '/heediq/api/orgs-table-name',
      '/heediq/api/users-table-name',
      '/heediq/api/jobs-table-name',
      '/heediq/api/audio-bucket-name',
      '/heediq/api/web-assets-bucket-name',
      '/heediq/api/transcription-queue-url',
      '/heediq/api/transcription-queue-arn',
      '/heediq/api/cognito-user-pool-id',
      '/heediq/api/cognito-user-pool-arn',
      '/heediq/api/cognito-client-id',
      '/heediq/api/cognito-hosted-ui-domain',
      '/heediq/api/ses-sending-role-arn',
      '/heediq/api/ws-connections-table-name',
      '/heediq/api/roles-table-name',
      '/heediq/api/groups-table-name',
      '/heediq/api/role-assignments-table-name',
      '/heediq/api/audit-log-table-name',
    ];
    for (const name of expectedParams) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: name });
    }
  });
});
