import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { createContextLibraryTables, ContextLibraryTables } from './context-library-tables';

export interface FoundationTables extends ContextLibraryTables {
  sourcesTable: dynamodb.Table;
  orgsTable: dynamodb.Table;
  usersTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  wsConnectionsTable: dynamodb.Table;
  userAuthMethodsTable: dynamodb.Table;
  authAuditLogTable: dynamodb.Table;
  rateLimitsTable: dynamodb.Table;
  cognitoIdentitiesTable: dynamodb.Table;
  rolesTable: dynamodb.Table;
  groupsTable: dynamodb.Table;
  roleAssignmentsTable: dynamodb.Table;
  auditLogTable: dynamodb.Table;
}

// ── DynamoDB — multi-table, PAY_PER_REQUEST, PITR on all (D-031, D-055, D-021) ──
export function createTables(scope: Construct, removalPolicy: cdk.RemovalPolicy): FoundationTables {
  const sourcesTable = new dynamodb.Table(scope, 'SourcesTable', {
    tableName: 'heediq-sources',
    partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
  // Admin list: all org sources, time-sorted
  sourcesTable.addGlobalSecondaryIndex({
    indexName: 'by-org-created',
    partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
  });
  // Member view: own sources, time-sorted (D-021 row-level isolation)
  sourcesTable.addGlobalSecondaryIndex({
    indexName: 'by-user-created',
    partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
  });

  // `defaultRoleId` (D-102) is a schema-only attribute — the org's seeded `member` system
  // role, assigned to new members at provisioning (Phase 3). Not indexed; no GSI needed.
  const orgsTable = new dynamodb.Table(scope, 'OrgsTable', {
    tableName: 'heediq-orgs',
    partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
  // Email-domain match for "request to join" flow (D-020)
  orgsTable.addGlobalSecondaryIndex({
    indexName: 'by-email-domain',
    partitionKey: { name: 'emailDomain', type: dynamodb.AttributeType.STRING },
  });

  const usersTable = new dynamodb.Table(scope, 'UsersTable', {
    tableName: 'heediq-users',
    partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
  // Org membership queries (admin seat management, D-017)
  usersTable.addGlobalSecondaryIndex({
    indexName: 'by-org',
    partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
  });
  // Email-as-identity lookup for cross-provider account linking (D-078) — email is
  // lowercased/trimmed by the writer before every put, never by the table itself.
  usersTable.addGlobalSecondaryIndex({
    indexName: 'by-email',
    partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
  });

  // Cognito sub -> Heediq accountId mapping (D-099). The stable identity anchor: every
  // Cognito identity (native or federated) a person has ever signed in with maps onto one
  // `accountId`, created once at first login and never rewritten. Replaces the old
  // by-email-GSI-guess used to reconcile a JWT's `sub` with a DynamoDB user row, which
  // diverged permanently whenever AdminLinkProviderForUser repointed a federated login's
  // future `sub` to a different destination user than the row the guess picked.
  const cognitoIdentitiesTable = new dynamodb.Table(scope, 'CognitoIdentitiesTable', {
    tableName: 'heediq-cognito-identities',
    partitionKey: { name: 'sub', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });

  // Auth methods-per-account + audit trail for cross-provider linking (D-087, replicating
  // EmotiXOrg/emotix-infra's schema). PK = `USER#<accountId>`; SK differs by table:
  // `METHOD#<PROVIDER>` (one row per linked sign-in method) vs `EVENT#<isoTimestamp>` (append-only).
  const userAuthMethodsTable = new dynamodb.Table(scope, 'UserAuthMethodsTable', {
    tableName: 'heediq-user-auth-methods',
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });

  const authAuditLogTable = new dynamodb.Table(scope, 'AuthAuditLogTable', {
    tableName: 'heediq-auth-audit-log',
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });

  // App-level OTP abuse throttling (D-097). PK = `<ROUTE>#<KEYTYPE>#<KEYVALUE>#<bucketStart>` —
  // the fixed-window bucket boundary lives in the key itself, not in TTL, because DynamoDB TTL
  // deletion isn't timed/guaranteed (can lag hours) so it can't be relied on to enforce a window
  // reset. TTL here is storage cleanup only. No point-in-time recovery — pure ephemeral counters.
  const rateLimitsTable = new dynamodb.Table(scope, 'RateLimitsTable', {
    tableName: 'heediq-rate-limits',
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: 'expiresAt',
    removalPolicy,
  });

  // PK = sourceId — one active job per source at MVP; DDB Streams feeds StatusPusher (D-061)
  const jobsTable = new dynamodb.Table(scope, 'JobsTable', {
    tableName: 'heediq-jobs',
    partitionKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    stream: dynamodb.StreamViewType.NEW_IMAGE,
    removalPolicy,
  });

  // PK = connectionId; GSIs by-user/by-org/by-broadcast for the three WS fan-out scopes
  // (D-109, generalizes D-061); TTL cleans up stale rows. Every row carries userId + orgId
  // (stamped by the connect Lambda from the validated JWT) and a constant broadcastKey='ALL'
  // so a broadcast push can query one GSI partition instead of a full table Scan.
  const wsConnectionsTable = new dynamodb.Table(scope, 'WsConnectionsTable', {
    tableName: 'heediq-ws-connections',
    partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: 'expiresAt',
    removalPolicy,
  });
  wsConnectionsTable.addGlobalSecondaryIndex({
    indexName: 'by-user',
    partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });
  wsConnectionsTable.addGlobalSecondaryIndex({
    indexName: 'by-org',
    partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });
  wsConnectionsTable.addGlobalSecondaryIndex({
    indexName: 'by-broadcast',
    partitionKey: { name: 'broadcastKey', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  // ── RBAC & audit trail tables (D-102, Phase 1 — schema only, no consumers yet) ───────
  // pk/sk composite convention, matching heediq-auth-audit-log / heediq-user-auth-methods.

  // pk=ORG#<orgId>, sk=ROLE#<roleId>
  const rolesTable = new dynamodb.Table(scope, 'RolesTable', {
    tableName: 'heediq-roles',
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });

  // pk=ORG#<orgId>, sk=GROUP#<groupId>
  const groupsTable = new dynamodb.Table(scope, 'GroupsTable', {
    tableName: 'heediq-groups',
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });

  // pk=ORG#<orgId>#USER#<userId>, sk=ROLE#<roleId> | GROUP#<groupId> — a user can hold
  // multiple direct role/group assignments. `by-role` is a sparse GSI (`roleId` present only
  // on role-type rows) kept for future by-role lookups; not currently queried by any consumer.
  const roleAssignmentsTable = new dynamodb.Table(scope, 'RoleAssignmentsTable', {
    tableName: 'heediq-role-assignments',
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
  roleAssignmentsTable.addGlobalSecondaryIndex({
    indexName: 'by-role',
    partitionKey: { name: 'roleId', type: dynamodb.AttributeType.STRING },
  });

  // pk=ORG#<orgId>, sk=<isoTimestamp>#<eventId> — write-once by construction (no
  // update/delete code path). `by-user` GSI serves "show this user's actions" queries.
  const auditLogTable = new dynamodb.Table(scope, 'AuditLogTable', {
    tableName: 'heediq-audit-log',
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
  auditLogTable.addGlobalSecondaryIndex({
    indexName: 'by-user',
    partitionKey: { name: 'actorUserId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });

  // Context Library tables (D-124–D-143) — split by concern per D-103, composed here.
  const contextLibrary = createContextLibraryTables(scope, removalPolicy);

  return {
    sourcesTable,
    orgsTable,
    usersTable,
    jobsTable,
    wsConnectionsTable,
    userAuthMethodsTable,
    authAuditLogTable,
    rateLimitsTable,
    cognitoIdentitiesTable,
    rolesTable,
    groupsTable,
    roleAssignmentsTable,
    auditLogTable,
    ...contextLibrary,
  };
}
