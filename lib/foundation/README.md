# Foundation

## Purpose

Provisions the per-workload-account resources every other stack depends on: DynamoDB tables, S3
buckets, the transcription SQS queue, the Cognito User Pool + federated IdPs, and the ACM wildcard
cert for custom domains. Deployed once per workload account (dev/staging/prod) as
`HeediqFoundationStack`.

Split into focused files by concern (D-103) — `foundation-stack.ts` is a slim composition root that
calls each factory in dependency order and assigns the results to its own `readonly` fields; no
resource-creation logic lives in the stack file itself.

## Key Files

- `foundation-stack.ts` — composition root: constructor wiring only, no resource creation
- `cert.ts` — `createWildcardCert()`, the ACM wildcard cert (D-053, D-063) + its SSM export
- `tables.ts` — `createTables()`, the 13 core/auth/RBAC DynamoDB tables (D-031) including the RBAC/audit set (D-102); composes in the Context Library tables
- `context-library-tables.ts` — `createContextLibraryTables()`, the 6 Context Library tables (D-124–D-143), split out as its own concern per D-103
- `storage.ts` — `createStorageAndQueues()`, the transcription SQS queue+DLQ and both S3 buckets (D-023)
- `ses.ts` — `createCognitoSesIdentity()`, the SES identity Cognito uses for its own OTP/confirmation emails (D-095)
- `auth-provision-lambda.ts` — `createAuthProvisionFn()`, the PreTokenGeneration trigger (D-077)
- `auth-linking-triggers.ts` — `createAuthLinkingTriggers()`, the 3 cross-provider account-linking triggers (D-087)
- `cognito.ts` — `createCognitoUserPool()`, the User Pool, hosted domain, Google/Microsoft IdPs, and app client (D-020)
- `ssm-exports.ts` — `exportSsmParams()`, the generic SSM `StringParameter` export loop (D-038)

## Data Flow / How It Works

`foundation-stack.ts`'s constructor calls the factories in this order, each receiving `this` (the
stack instance) as `scope` — **never** a nested `Construct` wrapper:

1. `createWildcardCert(this)`
2. `createTables(this, removalPolicy)`
3. `createStorageAndQueues(this, { removalPolicy, isProd })`
4. `createAuthProvisionFn(this, tables)`
5. `createCognitoSesIdentity(this)`
6. `createCognitoUserPool(this, { workloadEnv, removalPolicy, authProvisionFn, sesIdentity })`
7. `createAuthLinkingTriggers(this, tables, userPool)`
8. `exportSsmParams(this, [...])`

Each factory's constructs (`new dynamodb.Table(scope, 'SourcesTable', ...)`, etc.) are created
directly under `scope`, so their CloudFormation logical IDs and `aws:cdk:path` are identical to what
they'd be if the code were still inline in one file. This was verified by diffing
`cdk synth -c env=dev HeediqFoundationStack` before and after the split — the only difference was
resource ordering in the synthesized YAML (immaterial to CloudFormation, which treats the Resources
map as unordered), not any logical ID, property, or dependency.

## Contracts

Core/auth/RBAC tables: see `heediq-infra/README.md` Stack Map and the table names/GSIs in `tables.ts`.

### Context Library tables (`context-library-tables.ts`, D-124–D-143)

Schema-only at this step — no consumers yet (the API/worker/web steps follow). Item shapes are owned
by `@heediq/shared` (`context.ts`); only key/GSI design lives here. All PAY_PER_REQUEST + PITR.

| Table | PK | SK | GSI | Access pattern |
|---|---|---|---|---|
| `heediq-contexts` | `contextId` | — | `by-scope`: `scopeKey` / `domainCreatedAt` | Get a Context by id; list an org's Contexts by audience, grouped by Domain (D-141) |
| `heediq-extracted-items` | `sourceId` | `itemId` | `by-context`: `contextId` / `itemId` | Review wizard (by source); chat memory (by context, sparse on `contextId`) (D-135) |
| `heediq-decision-ledger` | `contextId` | `entryId` | — | All ledger entries for a Context (D-136) |
| `heediq-conversations` | `conversationId` | — | `by-context`: `contextId` / `updatedAt` | Get a thread; list a Context's threads, most-recently-active first (D-138) |
| `heediq-chat-messages` | `conversationId` | `sk` (`ts#messageId`) | — | Messages in a conversation, chronological (D-138) |
| `heediq-context-grants` | `granteeUserId` | `contextId` | `by-context`: `contextId` / `granteeUserId` | Cross-org access check + grantee's shared-with-me list; owner manages grantees (D-142) |

**`heediq-contexts` `by-scope` GSI (D-141):** the writer materializes `scopeKey` as `U#<userId>` /
`G#<groupId>` / `O#<orgId>` from the Context's `visibility` tier (personal/group/org), and
`domainCreatedAt` as `<domain>#<createdAt>`. A user's library = query `by-scope` for `U#<self>` +
`O#<orgId>` + `G#<groupId>` per group they belong to; one Domain filters via
`begins_with(domainCreatedAt, '<domain>#')`. Deliberately not a by-`orgId` GSI — that would leak
every member's personal Contexts to the whole org (a D-021 isolation violation).

The `@heediq/shared` `Context` gains `visibility`/`groupId` and the `context:share` permission in a
0.15.0 addendum; the writer that computes `scopeKey`/`domainCreatedAt` is API-step work.

## Dependencies

## Dependencies

- Upstream: `../config` (`WorkloadEnv`, `DOMAINS`, `ACCOUNTS`, `COMPUTE`)
- Downstream: every other stack that reads Foundation's SSM params or table/queue/pool references
  (`ApiStack`, `TranscriptionStack`, `WebSocketStack`, `SummarizationStack`, `WebStack`)
- Shared surfaces: `FoundationStack`'s public `readonly` fields are the contract other stacks import
  against — factory-internal types (`FoundationTables`, `FoundationStorage`, `FoundationCognito`)
  are internal wiring, not part of that public surface

## Testing

Mirrors this folder under `test/foundation/`: `cert.test.ts`, `tables.test.ts`, `storage.test.ts`,
`cognito.test.ts`, `auth-lambdas.test.ts`, `ssm-exports.test.ts`, `stack-prod.test.ts`, plus a shared
`test-utils.ts` (`synthDevTemplate()` / `synthProdTemplate()`, each synthesizing a fresh stack instance
per call so tests don't collide on construct IDs). Run via `pnpm test` from `heediq-infra/`. 185 tests
total across the whole package; this folder covers the DynamoDB/S3/SQS/Cognito/SSM assertions
formerly in the single `test/foundation-stack.test.ts`.

## Gotchas & Constraints

- **Never wrap `scope` in a new `Construct`** when adding a new factory here — the stack may already
  be deployed, and an extra construct level in the tree changes every descendant's logical ID,
  which CloudFormation reads as delete+recreate. Always pass the real `FoundationStack` instance
  (`this`) straight through.
- Factories that need cross-resource wiring (e.g. `createAuthLinkingTriggers` needing both `tables`
  and `userPool`) take those as explicit parameters rather than reaching into the stack — keeps each
  file's dependencies visible at its call site in `foundation-stack.ts`.
- **`heediq-decision-ledger` has no `orgId`** (the shipped `DecisionLedgerEntry` contract omits it),
  so cross-org isolation on ledger reads/writes runs through a context-ownership chain — the consumer
  must verify the caller owns the `contextId` before touching its ledger, not rely on a key-scoped
  partition. (D-136)
- **`heediq-context-grants` expiry is enforced in code, not by TTL.** The `expiresAt` TTL attribute is
  storage cleanup only — DynamoDB TTL deletion can lag hours — so every cross-org access must compare
  `expiresAt` at read time and treat an expired/revoked grant as no access. Same discipline as
  `heediq-rate-limits` (D-097). Grants are the single regulated crossing of D-021 org isolation
  (D-142); authorize against a live grant on every request, never cache it into the JWT.
