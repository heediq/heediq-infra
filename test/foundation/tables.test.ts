import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthDevTemplate } from './test-utils';

describe('FoundationStack — DynamoDB tables (dev)', () => {
  let template: Template;

  beforeAll(() => {
    template = synthDevTemplate();
  });

  it('creates 13 DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 13);
  });

  it('creates the cognito-identities table keyed by sub (D-099)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-cognito-identities',
      KeySchema: [{ AttributeName: 'sub', KeyType: 'HASH' }],
    });
  });

  it('all tables use PAY_PER_REQUEST', () => {
    template.allResourcesProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('all non-ws-connections, non-rate-limits tables have PITR enabled', () => {
    // ws-connections is ephemeral (TTL-managed) — PITR not required
    // rate-limits (D-097) is a transient fixed-window counter — PITR not required
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const [, resource] of Object.entries(tables)) {
      const props = (resource as { Properties: Record<string, unknown> }).Properties;
      if (props['TableName'] === 'heediq-ws-connections') continue;
      if (props['TableName'] === 'heediq-rate-limits') continue;
      const pitr = props['PointInTimeRecoverySpecification'] as { PointInTimeRecoveryEnabled?: boolean } | undefined;
      if (!pitr?.PointInTimeRecoveryEnabled) {
        throw new Error(`Table ${String(props['TableName'])} is missing PITR`);
      }
    }
  });

  it('sources table has correct key schema and 2 GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-sources',
      KeySchema: [
        { AttributeName: 'orgId', KeyType: 'HASH' },
        { AttributeName: 'sourceId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-org-created' }),
        Match.objectLike({ IndexName: 'by-user-created' }),
      ]),
    });
  });

  it('orgs table has emailDomain GSI for request-to-join lookup', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-orgs',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-email-domain' }),
      ]),
    });
  });

  it('users table has orgId GSI for member listing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-users',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-org' }),
      ]),
    });
  });

  it('users table has email GSI for cross-provider account linking (D-078)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-users',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'by-email',
          KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
        }),
      ]),
    });
  });

  it('jobs table uses sourceId as partition key with DDB Streams NEW_IMAGE enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-jobs',
      KeySchema: [{ AttributeName: 'sourceId', KeyType: 'HASH' }],
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    });
  });

  it('ws-connections table has connectionId PK, expiresAt TTL, and by-source GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-ws-connections',
      KeySchema: [{ AttributeName: 'connectionId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-source' }),
      ]),
    });
  });

  it('user-auth-methods table has pk/sk key schema (D-087)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-user-auth-methods',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });

  it('auth-audit-log table has pk/sk key schema (D-087)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-auth-audit-log',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });

  // ── RBAC & audit trail (D-102, Phase 1) ─────────────────────────────────────

  it('roles table has pk/sk key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-roles',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });

  it('groups table has pk/sk key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-groups',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });

  it('role-assignments table has pk/sk key schema and sparse by-role/by-group GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-role-assignments',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'by-role',
          KeySchema: [{ AttributeName: 'roleId', KeyType: 'HASH' }],
        }),
        Match.objectLike({
          IndexName: 'by-group',
          KeySchema: [{ AttributeName: 'groupId', KeyType: 'HASH' }],
        }),
      ]),
    });
  });

  it('audit-log table has pk/sk key schema and a by-user GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'heediq-audit-log',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'by-user',
          KeySchema: [
            { AttributeName: 'actorUserId', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });
});
