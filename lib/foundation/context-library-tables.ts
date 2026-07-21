import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface ContextLibraryTables {
  contextsTable: dynamodb.Table;
  extractedItemsTable: dynamodb.Table;
  decisionLedgerTable: dynamodb.Table;
  conversationsTable: dynamodb.Table;
  chatMessagesTable: dynamodb.Table;
  contextGrantsTable: dynamodb.Table;
}

// ── Context Library tables (D-124–D-143) ──────────────────────────────────────────────
// Split out of tables.ts as its own concern per D-103. All schema-only at this step — no
// consumers yet (the API/worker/web steps follow). Item shapes are defined by `@heediq/shared`
// (`context.ts`); DynamoDB is schemaless for non-key attributes, so only the key/GSI design lives
// here. Key design + access patterns documented in `lib/foundation/README.md` before adding, per
// engineering-standards §8. PAY_PER_REQUEST + PITR on all, matching the rest of Foundation
// (D-031/D-021).
export function createContextLibraryTables(
  scope: Construct,
  removalPolicy: cdk.RemovalPolicy,
): ContextLibraryTables {
  // ── heediq-contexts (D-129/D-134/D-141) ──
  // A Context (project/activity), self-nesting via `parentContextId` (non-key attr). PK=contextId
  // because a Source stores only `contextId` (D-128) and chat/review fetch a Context by id alone.
  // The `by-scope` GSI (D-141) serves the in-org library, categorized by Domain: the writer
  // materializes `scopeKey` (`U#<userId>` | `G#<groupId>` | `O#<orgId>`) from the Context's
  // visibility tier, and `domainCreatedAt` (`<domain>#<createdAt>`) so a user assembles their
  // library by querying `U#<self>` + `O#<orgId>` + `G#<groupId>` per group, filtering one Domain
  // via begins_with(domainCreatedAt, '<domain>#'). This is deliberately NOT a by-orgId GSI, which
  // would leak every member's personal Contexts to the whole org (a D-021 isolation violation).
  const contextsTable = new dynamodb.Table(scope, 'ContextsTable', {
    tableName: 'heediq-contexts',
    partitionKey: { name: 'contextId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
  contextsTable.addGlobalSecondaryIndex({
    indexName: 'by-scope',
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'domainCreatedAt', type: dynamodb.AttributeType.STRING },
  });

  // ── heediq-extracted-items (D-135) ──
  // One individually-addressable extracted statement. PK=sourceId serves the review wizard (all
  // items for a just-ingested Source). The `by-context` GSI is sparse on `contextId` (set only on
  // review placement) so unplaced/`proposed` items are naturally excluded from chat-memory queries
  // — chat assembles a Context's `kept` items (+ descendants, resolved app-side). `orgId` rides as
  // a non-key attr for isolation checks.
  const extractedItemsTable = new dynamodb.Table(scope, 'ExtractedItemsTable', {
    tableName: 'heediq-extracted-items',
    partitionKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
  extractedItemsTable.addGlobalSecondaryIndex({
    indexName: 'by-context',
    partitionKey: { name: 'contextId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
  });

  // ── heediq-decision-ledger (D-136) ──
  // Per-Context curated roll-up of key decisions/open questions. PK=contextId, SK=entryId.
  // The shipped `DecisionLedgerEntry` contract carries no `orgId`, so cross-org isolation runs
  // through a context-ownership chain (verify the caller owns the contextId first) — see README.
  const decisionLedgerTable = new dynamodb.Table(scope, 'DecisionLedgerTable', {
    tableName: 'heediq-decision-ledger',
    partitionKey: { name: 'contextId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'entryId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });

  // ── heediq-conversations (D-138) ──
  // Multiple named chat threads per Context. PK=conversationId (fetch a thread by id). The
  // `by-context` GSI lists a Context's threads, SK=updatedAt for most-recently-active-first order.
  const conversationsTable = new dynamodb.Table(scope, 'ConversationsTable', {
    tableName: 'heediq-conversations',
    partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
  conversationsTable.addGlobalSecondaryIndex({
    indexName: 'by-context',
    partitionKey: { name: 'contextId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
  });

  // ── heediq-chat-messages (D-138) ──
  // Durable messages within a conversation. PK=conversationId, SK=`sk` holds `ts#messageId` so
  // messages sort chronologically within a thread. Always accessed by conversationId — no GSI.
  const chatMessagesTable = new dynamodb.Table(scope, 'ChatMessagesTable', {
    tableName: 'heediq-chat-messages',
    partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });

  // ── heediq-context-grants (D-142) ──
  // The regulated cross-org sharing primitive — a deliberate, audited exception to D-021 org
  // isolation. Base PK=granteeUserId + SK=contextId is both the access-check point lookup and the
  // grantee's "shared-with-me" library query (at most one active grant per grantee+context). The
  // `by-context` GSI lets an owner list/revoke a Context's grantees. TTL on `expiresAt` is
  // cleanup-only — expiry MUST be enforced in code at read time because DynamoDB TTL deletion lags
  // (the heediq-rate-limits precedent, D-097). PITR kept on: grant state is security-critical.
  const contextGrantsTable = new dynamodb.Table(scope, 'ContextGrantsTable', {
    tableName: 'heediq-context-grants',
    partitionKey: { name: 'granteeUserId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'contextId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    timeToLiveAttribute: 'expiresAt',
    removalPolicy,
  });
  contextGrantsTable.addGlobalSecondaryIndex({
    indexName: 'by-context',
    partitionKey: { name: 'contextId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'granteeUserId', type: dynamodb.AttributeType.STRING },
  });

  return {
    contextsTable,
    extractedItemsTable,
    decisionLedgerTable,
    conversationsTable,
    chatMessagesTable,
    contextGrantsTable,
  };
}
