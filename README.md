# heediq-infra

AWS CDK infrastructure for all Heediq environments. All stacks, all accounts.

## Purpose

Single CDK TypeScript app that provisions every AWS resource Heediq depends on — across the
shared-services account (ECR, DNS, certs) and the three workload accounts (dev, staging, prod).
App repos deploy their Lambda/ECS code on top of this infrastructure; they do not provision
resources themselves.

## Key Files

- `bin/infra.ts` — CDK app entry; selects stacks by `-c env=<shared|dev|staging|prod>`
- `lib/config.ts` — all locked constants (account IDs, region, domains, compute sizing)
- `lib/shared-services/shared-services-stack.ts` — ECR, Route 53, ACM certs, SES identity + DKIM, cross-account email role
- `lib/foundation/foundation-stack.ts` — DynamoDB, S3, SQS, Cognito (per workload account)
- `lib/api/api-stack.ts` — Lambda (Hono API) + API Gateway
- `lib/web/web-stack.ts` — S3 + CloudFront (PWA hosting)
- `lib/transcription/transcription-stack.ts` — ECS cluster + EC2 GPU Spot ASG + task definitions (D-059)
- `lib/websocket/websocket-stack.ts` — WebSocket API + connection Lambda + Status Pusher Lambda (D-061)
- `lib/summarization/summarization-stack.ts` — SQS queue + Lambda (Claude extraction worker, D-065)
- `.github/workflows/deploy.yml` — CI/CD pipeline

## Stack Map

| Stack | Account | Region | Notes |
|---|---|---|---|
| `HeediqSharedServicesStack` | `313828097088` | eu-west-1 | ECR, Route 53, SES identity + DKIM, cross-account email role, Route 53 DNS manager role, ACM wildcard cert (shared-services own use only) |
| `HeediqSharedServicesCfCertStack` | `313828097088` | us-east-1 | ACM cert for CloudFront (must be us-east-1) |
| `HeediqFoundationStack` | per env | eu-west-1 | DynamoDB, S3, SQS, Cognito, ACM wildcard cert eu-west-1 (workload custom domains — D-063) |
| `HeediqApiStack` | per env | eu-west-1 | Lambda (Hono) + HTTP API + custom domain api-{env}.heediq.com (D-034, D-052) |
| `HeediqWorkloadCfCertStack` | per env | **us-east-1** | ACM wildcard cert for CloudFront (D-053) — cross-region, cert ARN passed to WebStack via CDK crossRegionReferences |
| `HeediqWebStack` | per env | eu-west-1 | CloudFront + S3 OAC + custom domain + security headers (D-053, D-055) |
| `HeediqTranscriptionStack` | per env | eu-west-1 | ECS cluster + EC2 GPU Spot ASG + task defs (D-059) |
| `HeediqSummarizationStack` | per env | eu-west-1 | Lambda (Claude extraction worker, D-065) |
| `HeediqWebSocketStack` | per env | eu-west-1 | WebSocket API + Status Pusher Lambda (D-061) |

Stack names carry no environment prefix — the account boundary is the environment boundary (D-037).
The same stack name (`HeediqFoundationStack`) exists in each workload account independently.

## How It Works

1. `shared-services` is deployed first (manually via `workflow_dispatch`) — it provisions ECR,
   the Route 53 hosted zone, and ACM certs. Its outputs are written to SSM params that workload
   stacks look up at deploy time.
2. Workload stacks deploy in order: `HeediqFoundationStack` first (shared resources), then the
   service stacks (`Api`, `Web`, `Transcription`, `Summarization`) which reference foundation
   outputs. CI deploys all workload stacks via `cdk deploy --all -c env=<env>`.
3. App repos (`heediq-api`, `heediq-web`, etc.) deploy their code (Lambda zip, S3 sync, ECS image
   tag update) on top of existing infra. They never create AWS resources — that's this repo.

## CI/CD

Per D-043:

Two workflow files (see `.github/workflows/`):

**`deploy.yml`** — workload accounts:

| Event | Action |
|---|---|
| Pull request | typecheck + unit tests + `cdk synth -c env=dev` (no AWS calls) |
| Push to `develop` (non-shared-services files) | Deploy all workload stacks to dev |
| Push to `main` | Deploy to staging → manual approval → deploy to prod |

**`deploy-shared-services.yml`** — shared-services account only:

| Event | Action |
|---|---|
| Pull request (`lib/shared-services/**` or `test/shared-services-stack.test.ts`) | typecheck + unit tests + synth only (no deploy) |
| Push to `develop` (same paths) | typecheck + unit tests + synth, then deploy |
| `workflow_dispatch` | Force re-deploy (escape hatch) |

Shared-services never deploys from `main` — it has no dev/staging/prod split. `deploy.yml` ignores `lib/shared-services/**`, `test/shared-services-stack.test.ts`, and `.github/**` so CI config changes and shared-services changes never trigger a workload deploy.

OIDC role assumed per account — no stored AWS credentials (D-036).

## Local Development

> **Regular developers** do not work directly with this repo or need AWS CLI configured — infra is
> managed by the owner and CI handles all deployments. These commands are for infra contributors.

```bash
pnpm install
pnpm typecheck                         # type-check only
pnpm cdk synth -c env=dev              # synthesize dev stacks (no AWS needed)
pnpm cdk diff -c env=dev               # diff against deployed dev (needs AWS creds)
pnpm cdk deploy --all -c env=dev       # deploy all dev stacks
```

AWS CLI profile needed for the target account — configure with `scripts/setup-aws-profiles.sh`
(see Scripts section below):

| Env | Profile |
|---|---|
| shared-services | `heediq-shared` |
| dev | `heediq-dev` |
| staging | `heediq-staging` |
| prod | `heediq-prod` |

## Initial Setup (owner-only, already done for this org)

> **Developers joining the team:** skip this section entirely. The AWS org, CDK bootstrap, OIDC
> roles, and shared-services stack are already provisioned. Configure your `heediq-dev` SSO profile
> and start working — see `claude-workspace/README.md` for machine setup.

This section documents what was done once when the AWS org was first set up. Repeat only if
re-provisioning from scratch (disaster recovery, new org).

The setup has a fixed order — shared-services must be fully deployed and `lib/config.ts` filled before any workload environment (dev/staging/prod) can deploy. Workload stacks reference the hosted zone ID from `lib/config.ts`; cert ARNs are read from SSM at deploy time.

### Step 0 — Configure AWS SSO profiles

Run **`scripts/setup-aws-profiles.sh`** — sets up all 4 AWS SSO profiles. You need the IAM
Identity Center start URL from the management account console.

```bash
bash scripts/setup-aws-profiles.sh
```

### Step 1 — Bootstrap + OIDC + IAM roles

Run **`scripts/setup.sh`** — covers all 4 accounts in one pass:

```bash
aws sso login --profile heediq-shared
aws sso login --profile heediq-dev
aws sso login --profile heediq-staging
aws sso login --profile heediq-prod

bash scripts/setup.sh
```

Idempotent. The script prints the GitHub Actions org-level variable values at the end — set those at the org level in GitHub before the first workflow run.

### Step 2 — Deploy shared-services

```bash
gh workflow run deploy-shared-services.yml --repo heediq/heediq-infra --ref develop
```

This creates: ECR repo, Route 53 hosted zone, SES identity + DKIM records, Zoho email DNS records, cross-account IAM roles (SES sending, Route 53 DNS manager), ACM wildcard cert eu-west-1 (shared-services' own), and ACM wildcard cert us-east-1 (for CloudFront).

> **Note:** Workload-facing `eu-west-1` ACM certs live in `FoundationStack` per workload account (D-063), not in shared-services. Each workload cert's validation CNAME must be added to Route 53 manually on first deploy — see [Domains, Subdomains & Certificates](#domains-subdomains--certificates).

### Step 3 — Update NS records at registrar

Take the `NameServers` output from `HeediqSharedServicesStack` and set them as the domain's authoritative nameservers at the registrar (replace, don't add). ACM cert validation happens automatically once DNS propagates (~10–30 min).

### Step 4 — Fill config.ts and commit

Only `hostedZoneId` needs to be captured — it goes in `lib/config.ts` and is never looked up at runtime.

```bash
aws cloudformation describe-stacks --stack-name HeediqSharedServicesStack \
  --profile heediq-shared \
  --query "Stacks[0].Outputs[?OutputKey=='HostedZoneId'].OutputValue" --output text
```

Fill `lib/config.ts → SHARED_SERVICES.hostedZoneId` and commit to develop.

> **Cert ARNs are NOT stored in SSM for workload stacks.** Each workload account creates its own wildcard cert in `FoundationStack` (D-063). The cert ARN is passed directly as a CDK prop — no SSM lookup needed at deploy time. See [Domains, Subdomains & Certificates](#domains-subdomains--certificates) for the one-time DNS validation CNAME step required per environment.

## Contracts

- **SSM param convention**: `/heediq/{service}/{param}` — no environment prefix (D-038)
- **Resource naming**: `heediq-{entity}` — no environment prefix (D-037). **Exception:** S3 bucket names are globally unique, so buckets append the account ID: `heediq-audio-uploads-{accountId}`. App repos always resolve bucket names via SSM, never hardcode them.
- **Secrets**: never in code or env files; fetched at Lambda cold start via a direct Secrets Manager SDK call, cached at module scope (D-100, narrows D-038)
- **DynamoDB**: `PAY_PER_REQUEST` in all environments (D-055)
- **Compute sizing**: see `lib/config.ts` → `COMPUTE` (D-055)

### SharedServicesStack SSM params

| SSM path | Value |
|---|---|
| `/heediq/shared/hosted-zone-id` | Route 53 hosted zone ID for `heediq.com` |
| `/heediq/shared/route53-dns-manager-role-arn` | IAM role ARN — assumed by workload CDK custom resources to manage Route 53 DNS records (D-064) |

### FoundationStack SSM params (consumed by all app repos)

| SSM path | Value |
|---|---|
| `/heediq/infra/cert-arn-eu-west-1` | ACM wildcard cert ARN (eu-west-1) — API Gateway + WebSocket custom domains (D-063) |
| `/heediq/api/sources-table-name` | `heediq-sources` |
| `/heediq/api/orgs-table-name` | `heediq-orgs` |
| `/heediq/api/users-table-name` | `heediq-users` |
| `/heediq/api/jobs-table-name` | `heediq-jobs` |
| `/heediq/api/ws-connections-table-name` | `heediq-ws-connections` — WebSocket connection tracking (D-061) |
| `/heediq/api/audio-bucket-name` | `heediq-audio-uploads-{accountId}` |
| `/heediq/api/web-assets-bucket-name` | `heediq-web-assets-{accountId}` |
| `/heediq/api/transcription-queue-url` | SQS queue URL |
| `/heediq/api/transcription-queue-arn` | SQS queue ARN |
| `/heediq/api/cognito-user-pool-id` | Cognito User Pool ID |
| `/heediq/api/cognito-user-pool-arn` | Cognito User Pool ARN |
| `/heediq/api/cognito-client-id` | Cognito App Client ID (no secret — public browser client) |
| `/heediq/api/ses-sending-role-arn` | IAM role ARN in shared-services account for cross-account SES sending (D-058) |

### TranscriptionStack resources

**Architecture (D-059, D-060):**

| Resource | Details |
|---|---|
| ECS cluster | `heediq-transcription` |
| VPC | `heediq-transcription` — public subnets only (eu-west-1a/b), no NAT gateway |
| CloudWatch log group | `/heediq/transcription` (30-day retention; no PII logged, D-038) |
| EC2 instance type | g4dn.xlarge — T4 GPU (16 GB VRAM), 4 vCPU, 16 GB RAM; Spot, capacity-optimized allocation |
| Auto Scaling Group | `heediq-transcription-asg` — min=0, max=N; managed by ECS capacity provider |
| Launch Template | ECS-optimized GPU AMI (CUDA + nvidia-container-toolkit + ECS agent pre-configured); user-data registers instance with ECS cluster |
| ECS capacity provider | `heediq-transcription-ec2` — managed scaling + managed termination protection |
| Task def — free | family `heediq-transcription-free` — whisper small image (`:free-sha-<7chars>` from SSM `/heediq/transcription/free-image-tag`); 1 GPU / 1 vCPU / 2 GB (D-062) |
| Task def — paid | family `heediq-transcription-paid` — large-v3 + pyannote image (`:paid-sha-<7chars>` from SSM `/heediq/transcription/paid-image-tag`); 1 GPU / 4 vCPU / 8 GB (D-062) |
| EventBridge Pipes | `heediq-transcription-free` / `heediq-transcription-paid` — filter on SQS `messageAttributes.tier`; batchSize=1; `SQS_MESSAGE_BODY` container override (`<$.body>`); EC2 capacity provider (D-059, D-066) |
| IAM execution role | `heediq-transcription-execution` — cross-account ECR pull (shared-services 313828097088) + CloudWatch Logs write |
| IAM task role | `heediq-transcription-task` — S3 read (audio uploads bucket, no write grant; transcript goes to DynamoDB) + DynamoDB read/write (heediq-jobs + heediq-sources) + `sqs:SendMessage` on `heediq-summarization` (D-065) + `sqs:SendMessage` on `heediq-transcription` (Spot re-enqueue, D-066) |
| IAM instance role | `heediq-transcription-instance` — ECS agent registration, CloudWatch Logs, SSM agent access |
| IAM pipe role | `heediq-transcription-pipe` — SQS consume + `ecs:RunTask` + `iam:PassRole` |
| ECR images | `313828097088.dkr.ecr.eu-west-1.amazonaws.com/heediq-worker-transcription:{free\|paid}-sha-<7chars>` — two per-tier images, sha-tagged (D-047, D-062); image tag promoted per-environment by CI via `aws ssm put-parameter` + `ecs register-task-definition` + `aws pipes update-pipe` |

**Message routing (D-059, D-060, D-062):** The API enqueues jobs with `messageAttributes.tier = 'free' | 'paid'` (required — without this attribute both Pipe filters fail and the job is silently never picked up). Access to `paid` (large-v3) is enforced at the API enqueue endpoint — free users are rejected if they request it. Each EventBridge Pipe filters on tier and launches the matching task definition via `RunTask`. No idle containers — tasks launch on demand, EC2 instance terminates after job completes. No `TIER` env var in task definitions — tier is per-image, not env-based (D-062).

**Spot interruption (D-066):** Pipes deletes the SQS message the moment it hands the job to `RunTask` — before the worker process starts. There is no visibility-timeout left to expire by the time a Spot SIGTERM arrives. Worker catches SIGTERM → writes `status=retrying` → **explicitly re-enqueues** `TranscriptionJobMessage` to `heediq-transcription` with the `tier` message attribute preserved (required for the Pipe filter to re-route the retried job correctly).

### WebSocketStack resources (D-061)

| Resource | Details |
|---|---|
| WebSocket API | API Gateway WebSocket API — `$connect` / `$disconnect` / `$default` routes, stage `ws`, auto-deploy |
| Connection Lambda | `heediq-ws-connect` — on `$connect`: validates JWT, stores `connectionId` in `heediq-ws-connections`; on `$disconnect`: removes row. 29s timeout (WebSocket $connect hard limit). |
| Status Pusher Lambda | `heediq-ws-status-pusher` — triggered by DDB Streams on `heediq-jobs`; queries `heediq-ws-connections` GSI `by-source`; POSTs status to each active `connectionId` via `execute-api:ManageConnections`. Deletes stale connections on `GoneException`. |
| Custom domains | `ws.heediq.com` (prod) / `ws-staging.heediq.com` (staging) / `ws-dev.heediq.com` (dev) — wildcard cert from `FoundationStack.wildcardCert` (same workload account, D-063) |
| IAM: pusher role | `execute-api:ManageConnections` scoped to WebSocket API ARN |

**Status stages pushed to client:** `queued → starting → transcribing → diarizing (large-v3 only) → summarizing → done / failed`

`starting` is the worker's first DynamoDB write before model load — makes EC2 cold-start latency visible as "Transcription server starting…" rather than a silent wait.

**SSM params (WebSocketStack):**

| SSM path | Value |
|---|---|
| `/heediq/api/ws-endpoint-url` | `wss://ws-{env}.heediq.com` — consumed by `heediq-web` and `heediq-api` |
| `/heediq/api/ws-regional-domain-name` | API Gateway regional domain name — Route 53 A-alias target |

### SummarizationStack resources (D-032, D-055, D-065)

Source-agnostic summarization pipeline. All content types — audio transcripts, text files, PDFs, emails, Excel — enqueue to the same SQS queue. The Lambda calls the Claude API and writes structured extraction output to DynamoDB.

| Resource | Details |
|---|---|
| SQS queue | `heediq-summarization` — batchSize=1 event source, 360s visibility timeout (Lambda 300s + 60s buffer), SSL enforced |
| DLQ | `heediq-summarization-dlq` — 14-day retention; receives after 3 failed attempts |
| Lambda | `heediq-summarization` — Node.js 22, 512 MB, 300s timeout (D-055). Placeholder code; real implementation deployed by `heediq-worker-summarization` CI (D-043, D-050). |
| IAM: Lambda role | `secretsmanager:GetSecretValue` on `/heediq/summarization/*` (Claude API key, D-032). DynamoDB read/write: `heediq-jobs` (status: `summarizing → done/failed`) + `heediq-sources` (structured extraction output). S3 read: `heediq-audio-uploads-*` (transcript files and direct-path content). |

**Message flow (D-065, D-067):**
- Audio path: transcription worker → enqueues `{ sourceType: 'text', contentRef: sourceId, tier }` after faster-whisper completes. `tier` is forwarded from `TranscriptionJobMessage`; summarization worker uses it to select the Claude model (Haiku/Sonnet, D-067). Transcript is written to `heediq-sources[sourceId].transcript` in DynamoDB (task role has no S3 write grant); `heediq-worker-summarization` reads it back by `sourceId`
- Direct path: API Lambda → enqueues `{ sourceType: 'text', contentRef: sourceId, tier }` for direct non-audio uploads (D-026). Note: `SourceType` in `@heediq/shared` currently only supports `'audio' | 'text'`; pdf/email/Excel support is planned but not yet in the schema.

**Pre-deployment secret required (per workload account):** `Secrets Manager /heediq/summarization/anthropic-api-key` — Anthropic API key; fetched by the Lambda at cold start via a direct Secrets Manager SDK call, cached at module scope (D-100). Must exist before the first `heediq-worker-summarization` Lambda invocation.

**Cross-stack IAM (no CDK dependency required):** `heediq-summarization` queue ARN is deterministic (`arn:aws:sqs:{region}:{account}:heediq-summarization`) — TranscriptionStack task role and ApiStack Lambda role each receive `sqs:SendMessage` using the constructed ARN. Both also receive `SUMMARIZATION_QUEUE_URL` as an env var.

**SSM params (SummarizationStack):**

| SSM path | Value |
|---|---|
| `/heediq/summarization/queue-url` | SQS queue URL — enqueue target for all content sources |
| `/heediq/summarization/queue-arn` | SQS queue ARN |
| `/heediq/infra/summarization-lambda-arn` | Lambda ARN — consumed by future orchestration |

### ApiStack resources (D-034, D-041, D-042, D-052)

| Resource | Details |
|---|---|
| API Lambda | `heediq-api` — Node.js 22, 512 MB, 30s timeout (D-055). Placeholder code in stack; real implementation deployed by `heediq-api` CI (D-043, D-050). |
| HTTP API | API Gateway HTTP API `heediq-api` — `$default` stage, auto-deploy. Catch-all route `ANY /{proxy+}` → Lambda via AWS_PROXY (payload format 2.0). CORS: web domain per env + `localhost:5173` in dev. JWT validation in Hono middleware, not at Gateway (D-041). |
| Custom domains | `api.heediq.com` (prod) / `api-staging.heediq.com` (staging) / `api-dev.heediq.com` (dev) — wildcard cert from `FoundationStack.wildcardCert` (same workload account, D-063) |
| IAM: Lambda role | DynamoDB read/write: sources, orgs, users, jobs, **user-auth-methods** (D-087), **auth-audit-log** (write-only, D-087); read-only: ws-connections. S3 read/write: audioUploadsBucket (presigned URLs + audio read). SQS send: transcriptionQueue + **summarizationQueue** (D-065). `secretsmanager:GetSecretValue` on `/heediq/api/*`. `sts:AssumeRole` on `heediq-ses-email-sending` (D-058). |

**SSM params (ApiStack):**

| SSM path | Value |
|---|---|
| `/heediq/api/endpoint-url` | `https://api-{env}.heediq.com` — consumed by `heediq-web` |
| `/heediq/api/regional-domain-name` | API Gateway REST regional domain name — Route 53 A-alias target |

### WorkloadCfCertStack resources (D-053)

ACM wildcard cert (`*.heediq.com` + `heediq.com`) in **us-east-1** per workload account. Required by CloudFront — AWS hard requirement. Deployed to `us-east-1` of each workload account alongside the eu-west-1 stacks.

| Resource | Details |
|---|---|
| ACM cert | `*.heediq.com` + SAN `heediq.com` — DNS validation, `fromDns()` without hosted zone arg (manual CNAME required, see [Setting up a new environment from scratch](#setting-up-a-new-environment-from-scratch)) |
| SSM param | `/heediq/infra/cert-arn-us-east-1` (in us-east-1) — manual reference; runtime CDK access is via prop |
| CDK output | `CloudFrontCertArn` — passed to WebStack as `cfCert` prop via `crossRegionReferences: true` |

**Note:** ACM generates a unique CNAME for this cert — different from the eu-west-1 cert CNAME. Both CNAMEs must be added to Route 53 in shared-services for a new environment to go fully live.

### WebStack resources (D-053, D-055)

CloudFront distribution serving the React PWA from S3. Static assets are deployed by `heediq-web` CI (S3 sync of Vite build output) — this stack provisions the infrastructure only.

| Resource | Details |
|---|---|
| CloudFront distribution | `heediq.com` / `staging.heediq.com` / `dev.heediq.com`; `PriceClass_100` (US + EU, D-055); HTTP/2 + HTTP/3; default root `index.html` |
| S3 origin | `heediq-web-assets-{accountId}` with OAC (Origin Access Control). Bucket policy (source-account condition) lives in FoundationStack to avoid circular CDK dep — see `lib/foundation/foundation-stack.ts` comment. |
| OAC | `S3OriginAccessControl`, SIGV4 signing — replaces legacy OAI |
| SPA routing | 403 + 404 from S3 → `/index.html` HTTP 200 (client-side React Router handles the path) |
| Security headers | HSTS (1yr, includeSubdomains), X-Frame-Options DENY, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy strict-origin-when-cross-origin |
| Custom domain | `Route53AliasRecord` → CloudFront (targetHostedZoneId `Z2FDTNDATAQYW2` — CloudFront's global fixed zone ID) |
| ACM cert | `WorkloadCfCertStack.cfCert` (us-east-1) passed as CDK prop via `crossRegionReferences` |

**SSM params (WebStack):**

| SSM path | Value |
|---|---|
| `/heediq/web/url` | `https://{web-domain}` — consumed by `heediq-api` (CORS) and `heediq-web` (runtime config) |
| `/heediq/web/cloudfront-distribution-id` | Distribution ID — used by `heediq-web` CI for `aws cloudfront create-invalidation` |

### FoundationStack DynamoDB key design

| Table | PK | SK | GSIs | Streams |
|---|---|---|---|---|
| `heediq-sources` | `orgId` | `sourceId` | `by-org-created` (PK=orgId SK=createdAt), `by-user-created` (PK=userId SK=createdAt) | — |
| `heediq-orgs` | `orgId` | — | `by-email-domain` (PK=emailDomain) | — |
| `heediq-users` | `userId` | — | `by-org` (PK=orgId SK=userId), `by-email` (PK=email) | — |
| `heediq-jobs` | `sourceId` | — | — | **NEW\_IMAGE** (required for D-061 Status Pusher Lambda trigger) |
| `heediq-ws-connections` | `connectionId` | — | `by-source` (PK=`sourceId`), TTL on `expiresAt` | — |
| `heediq-user-auth-methods` | `pk` | `sk` | — | — |
| `heediq-auth-audit-log` | `pk` | `sk` | — | — |

`heediq-ws-connections` was added in FoundationStack alongside `HeediqWebSocketStack` (D-061). Deployed.

`heediq-users.by-email` (PK=`email`) backs the email-as-identity lookup for cross-provider account linking (D-078) — the writer lowercases/trims email before every put; the table itself does no normalization.

`heediq-user-auth-methods`/`heediq-auth-audit-log` (D-087) share one key shape: `pk = USER#<canonicalAccountId>`; `sk = METHOD#<PROVIDER>` (one idempotent row per linked sign-in method, conditional put on `attribute_not_exists`) in the methods table, `sk = EVENT#<isoTimestamp>` (append-only) in the audit table.

### FoundationStack Cognito — prerequisite before first deploy

Create placeholder secrets in the target account before deploying FoundationStack:

```bash
aws secretsmanager create-secret --name /heediq/auth/google-client-secret \
  --secret-string "placeholder" --profile heediq-dev
aws secretsmanager create-secret --name /heediq/auth/microsoft-client-secret \
  --secret-string "placeholder" --profile heediq-dev
aws ssm put-parameter --name /heediq/auth/google-client-id \
  --value "placeholder" --type String --profile heediq-dev
aws ssm put-parameter --name /heediq/auth/microsoft-client-id \
  --value "placeholder" --type String --profile heediq-dev
aws ssm put-parameter --name /heediq/auth/microsoft-issuer-url \
  --value "https://login.microsoftonline.com/organizations/v2.0" --type String --profile heediq-dev
```

Replace placeholders with real credentials from Google Cloud Console and Azure portal (D-020). Email/password auth works immediately; federated sign-in activates once real credentials are set.

**Note on Microsoft issuer URL:** `organizations` is the correct placeholder — it's a real Microsoft OIDC discovery endpoint Cognito can reach at deploy time. Using `placeholder` as the tenant ID causes a deploy failure. When setting up the Azure app registration, update this to the specific tenant URL: `https://login.microsoftonline.com/{tenant-id}/v2.0`.

### FoundationStack Cognito triggers (D-087)

3 Lambda triggers wired on the User Pool, real code deployed by `heediq-api` CI (placeholder inline code in the stack, same pattern as `auth-provision.ts`/PreTokenGeneration):

| Trigger | Fires on | Purpose |
|---|---|---|
| `AuthTriggerPreSignUpFn` (`PRE_SIGN_UP`) | `PreSignUp_ExternalProvider` | Links a brand-new federated login onto a matching native account by email before Cognito creates the external-provider user |
| `AuthTriggerPostConfirmationFn` (`POST_CONFIRMATION`) | `PostConfirmation_ConfirmSignUp` | Records the auth method (native `COGNITO` or federated provider) + an audit event; never writes the main `users` row |
| `AuthTriggerPostAuthenticationFn` (`POST_AUTHENTICATION`) | `PostAuthentication_Authentication` | Records the auth method used for the completed login; auto-links a federated login to an existing native account with the same email if not yet linked |

All three write to `heediq-user-auth-methods`/`heediq-auth-audit-log`; `AuthTriggerPreSignUpFn`/`AuthTriggerPostAuthenticationFn` additionally call Cognito Admin APIs (`AdminCreateUser`, `AdminLinkProviderForUser`, `ListUsers`). All three also receive `USERS_TABLE_NAME` (read-only `grantReadData`), since auto-linking needs to look up the existing native account by email.

**Gotcha — CDK circular dependency avoidance:** these trigger Lambdas' IAM policies cannot reference `this.userPool.userPoolArn` directly. The pool's `LambdaConfig` already depends on the Lambdas via `addTrigger`, so a policy referencing the pool's own live ARN creates a genuine CloudFormation cycle (`UserPool → Lambda → LambdaRolePolicy → UserPool`). Instead, scope the policy to an account/region ARN pattern built from CDK pseudo-parameters: `cdk.Stack.of(this).formatArn({ service: 'cognito-idp', resource: 'userpool', resourceName: '*' })`. This stays account/region-scoped (not a bare `*`) and is safe because each account has exactly one User Pool (D-037).

### SummarizationStack — prerequisite before first Lambda invocation

The summarization Lambda IAM role has `secretsmanager:GetSecretValue` on `/heediq/summarization/*`. The stack deploys without the secret existing, but the Lambda will fail at cold-start if the secret is absent. Create it before traffic reaches the Lambda:

```bash
aws secretsmanager create-secret \
  --name /heediq/summarization/anthropic-api-key \
  --secret-string "placeholder" \
  --profile heediq-dev
```

Replace `placeholder` with the real Anthropic API key from the Anthropic console (D-032). The Lambda's `config.ts` fetches this via a direct Secrets Manager SDK call at cold start, cached at module scope (D-100); rotating the secret value takes effect on the next cold-start.

### TranscriptionStack — SSM image-tag params prerequisite before first deploy

`TranscriptionStack` uses CloudFormation dynamic SSM references (`{{resolve:ssm:...}}`) for image tags. CloudFormation resolves them at deploy time — if the parameters don't exist the deploy fails immediately. `scripts/setup.sh` seeds these automatically (idempotent — skips if already set so CI-promoted values are never overwritten).

If you need to seed manually:

```bash
aws ssm put-parameter --name /heediq/transcription/free-image-tag --value free --type String --profile heediq-dev
aws ssm put-parameter --name /heediq/transcription/paid-image-tag --value paid --type String --profile heediq-dev
```

The placeholder value doesn't need to be a real image tag — ECS only validates image existence when a task actually launches, not when the task definition is registered. Once `heediq-worker-transcription` CI runs its first promote step, it overwrites these with real `free-sha-<7chars>` / `paid-sha-<7chars>` values and registers updated task definition revisions.

## Domains, Subdomains & Certificates

### Domain & subdomain structure (D-052)

All subdomains are single-level — all covered by the `*.heediq.com` wildcard cert. Prod uses the root domain; staging/dev carry an environment prefix:

| Service | Prod | Staging | Dev |
|---|---|---|---|
| Web (CloudFront) | `heediq.com` | `staging.heediq.com` | `dev.heediq.com` |
| API (API Gateway) | `api.heediq.com` | `api-staging.heediq.com` | `api-dev.heediq.com` |
| WebSocket | `ws.heediq.com` | `ws-staging.heediq.com` | `ws-dev.heediq.com` |

Defined in `lib/config.ts → DOMAINS`. Single-level subdomains keep all names within `*.heediq.com`; two-level names (e.g. `api.staging.heediq.com`) would require additional per-environment wildcard certs.

### Certificate placement (D-053, D-063)

#### Why two cert regions?

AWS hard-codes cert requirements per service:
- **CloudFront** requires the cert in `us-east-1` — regardless of where the distribution serves or where the origin lives. Cannot be changed.
- **API Gateway regional endpoint** requires the cert in the same region as the endpoint (`eu-west-1`). Cannot be changed.

#### Why per-workload-account certs?

ACM certificates cannot be referenced cross-account. When the shared-services account cert was tried with API Gateway in a workload account, CloudFormation rejected it at deploy time. There is no workaround — ACM certs must live in the same AWS account as the service using them.

Consequence: each workload account (dev/staging/prod) owns two wildcard certs — one per region.

#### All certs in the system

| Cert | Account | Region | CDK location | Used by |
|---|---|---|---|---|
| `*.heediq.com` + `heediq.com` | dev/staging/prod | eu-west-1 | `FoundationStack.wildcardCert` | `ApiStack`, `WebSocketStack` — passed as CDK prop |
| `*.heediq.com` + `heediq.com` | dev/staging/prod | **us-east-1** | `WorkloadCfCertStack.cfCert` | `WebStack` CloudFront — passed as CDK prop via `crossRegionReferences` |
| `*.heediq.com` | shared-services | eu-west-1 | `SharedServicesStack.certEuWest1` | Shared-services own use only — **NOT** referenced by workload stacks |
| `*.heediq.com` | shared-services | **us-east-1** | `SharedServicesCfCertStack` | Shared-services own CloudFront — **NOT** referenced by workload stacks |

#### How the us-east-1 cert reaches WebStack (CDK crossRegionReferences)

CloudFront lives in `eu-west-1`; its cert must be in `us-east-1`. CDK cannot directly reference a resource across regions in the same CDK app without help.

CDK `crossRegionReferences: true` on both stacks enables SSM-backed cross-region parameter exchange:
1. `WorkloadCfCertStack` (us-east-1) writes the cert ARN to an SSM parameter in us-east-1.
2. CDK's cross-region support reads that SSM parameter from eu-west-1 at deploy time.
3. `WebStack` (eu-west-1) receives `cfCert` as a TypeScript prop — same as any other CDK prop; no explicit SSM lookup needed in stack code.

```ts
// bin/infra.ts
const workloadCfCertStack = new WorkloadCfCertStack(app, 'HeediqWorkloadCfCertStack', {
  env: { account: ACCOUNTS[workloadEnv], region: CERT_REGION }, // us-east-1
  crossRegionReferences: true,
});
new WebStack(app, 'HeediqWebStack', {
  env: { ..., region: AWS_REGION }, // eu-west-1
  crossRegionReferences: true,
  cfCert: workloadCfCertStack.cfCert,  // ← this works because of crossRegionReferences
});
```

**Deployment order:** WorkloadCfCertStack must be deployed and cert ISSUED before WebStack deploys (CDK reads the SSM param during synthesis). If you run `cdk deploy --all`, CDK handles the ordering automatically.

### ACM DNS validation — manual, one-time per cert

ACM cannot auto-create DNS records in Route 53 when Route 53 is in a different account (shared-services) than the cert (workload account). CDK's `CertificateValidation.fromDns()` is called **without** a hosted zone argument — this generates the CNAME record details but does not create the Route 53 record. You create it manually once; ACM auto-renews using the same CNAME indefinitely.

> **Observed behaviour (dev, 2026-06-26):** ACM validated the `WorkloadCfCertStack` us-east-1 cert automatically without a manual CNAME step. This happens when a validation CNAME for the same domain already exists in Route 53 — ACM reuses existing records. If the eu-west-1 cert's CNAME is already present and covers `*.heediq.com`, a second cert for the same domain in a different region may validate against it. For new environments where no prior CNAME exists, the manual step is still required.

#### Two certs = two CNAMEs per environment

Each cert request generates a **unique CNAME** — two certs for `*.heediq.com` in different accounts get different CNAMEs. Each environment needs two CNAMEs added to Route 53:

| Cert | CDK stack | Region | When to add CNAME |
|---|---|---|---|
| eu-west-1 workload cert | `FoundationStack` | eu-west-1 | After first `HeediqFoundationStack` deploy |
| us-east-1 workload cert | `WorkloadCfCertStack` | us-east-1 | After first `HeediqWorkloadCfCertStack` deploy |

Both CNAMEs go into the same Route 53 hosted zone in shared-services (`Z0875312RP7WHSNW7AUM`).

#### How to add a cert validation CNAME (reference)

This applies to both certs. Substitute the correct profile, region, and ARN.

**1 — Get the cert ARN from the CloudFormation output:**
```bash
# For FoundationStack (eu-west-1):
aws cloudformation describe-stacks \
  --stack-name HeediqFoundationStack \
  --region eu-west-1 \
  --profile heediq-<env> \
  --query "Stacks[0].Outputs[?OutputKey=='WildcardCertArn'].OutputValue" \
  --output text

# For WorkloadCfCertStack (us-east-1):
aws cloudformation describe-stacks \
  --stack-name HeediqWorkloadCfCertStack \
  --region us-east-1 \
  --profile heediq-<env> \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontCertArn'].OutputValue" \
  --output text
```

**2 — Get the validation CNAME details from ACM:**
```bash
aws acm describe-certificate \
  --certificate-arn <arn-from-step-1> \
  --region <eu-west-1 or us-east-1> \
  --profile heediq-<env> \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
```

Output:
```json
{ "Name": "_<hex>.heediq.com.", "Type": "CNAME", "Value": "_<hex>.acm-validations.aws." }
```

**3 — Add the CNAME to Route 53 in shared-services:**
```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id Z0875312RP7WHSNW7AUM \
  --profile heediq-shared \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "_<hex>.heediq.com.",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "_<hex>.acm-validations.aws."}]
      }
    }]
  }'
```

**4 — Wait for validation:**
```bash
# Poll until Status = ISSUED (~5–10 min):
aws acm describe-certificate \
  --certificate-arn <arn> \
  --region <region> \
  --profile heediq-<env> \
  --query "Certificate.Status"
```

CloudFormation waits automatically — once ISSUED the CDK deploy continues.

> **Important:** Run `UPSERT`, never `CREATE`. If the CNAME already exists from a previous attempt, `UPSERT` is a no-op. `CREATE` errors out on duplicates.

#### Troubleshooting cert validation

**Cert stuck in `PENDING_VALIDATION` after 15+ minutes:**
1. Verify the CNAME was added to the correct hosted zone (check `Z0875312RP7WHSNW7AUM` in shared-services account).
2. Confirm the CNAME name/value match exactly what ACM reported (trailing dot on the name is correct).
3. Run `dig _<hex>.heediq.com CNAME +short` — should return `_<hex>.acm-validations.aws.` once DNS has propagated.
4. If no result: check that the Route 53 hosted zone is authoritative (NS records match registrar nameservers).

**FoundationStack deploy times out waiting for cert:**
- CDK waits up to 30 minutes for the cert. If you added the CNAME after deploy started, it will still pick it up — ACM validates continuously.
- If CDK times out: add CNAME (if not done), then re-run `cdk deploy HeediqFoundationStack`. CDK is idempotent.

**WorkloadCfCertStack cert CNAME different from FoundationStack CNAME:**
- This is expected and correct. Every cert request generates a unique CNAME. Two certs for `*.heediq.com` in different accounts always get different validation records.

#### DNS validation status per environment

| Account | Cert region | Status |
|---|---|---|
| dev | eu-west-1 (FoundationStack) | **ISSUED** — CNAME added 2026-06-25 |
| dev | us-east-1 (WorkloadCfCertStack) | **ISSUED** — validated automatically on first deploy (2026-06-26); existing `*.heediq.com` CNAME in Route 53 reused |
| staging | eu-west-1 | **Not deployed** |
| staging | us-east-1 | **Not deployed** |
| prod | eu-west-1 | **Not deployed** |
| prod | us-east-1 | **Not deployed** |

### A-alias DNS records — automated via Route53AliasRecord construct

Custom domain A-alias records (the records that point `api-dev.heediq.com` → API Gateway, `dev.heediq.com` → CloudFront, etc.) are created **automatically** by the `Route53AliasRecord` CDK custom resource at stack deploy time. No manual CLI step is needed for these.

The construct (`lib/shared/route53-alias-record.ts`) is a Lambda-backed CDK custom resource that:
1. Assumes `heediq-route53-dns-manager` IAM role in shared-services account
2. Calls `route53:ChangeResourceRecordSets` to create/update the A-alias record in the `heediq.com` hosted zone
3. On stack deletion, removes the record (CDK lifecycle hook)

**CloudFront A-alias note:** CloudFront uses a fixed hosted zone ID `Z2FDTNDATAQYW2` for A-alias records — this is a global AWS constant, the same for every CloudFront distribution everywhere. It is hardcoded in `lib/web/web-stack.ts` as `CLOUDFRONT_HOSTED_ZONE_ID`.

### Cross-account Route 53 DNS manager role (D-064)

IAM role **`heediq-route53-dns-manager`** in shared-services account (`313828097088`):

| Property | Value |
|---|---|
| Trust | Workload accounts: dev (`276594885933`), staging (`475790160542`), prod (`438825592314`) |
| Permissions | `route53:ChangeResourceRecordSets`, `route53:ListResourceRecordSets`, `route53:GetChange` on hosted zone `Z0875312RP7WHSNW7AUM` only |
| ARN in SSM | `/heediq/shared/route53-dns-manager-role-arn` |

This role is used for:
1. **ACM cert validation CNAMEs** — **manual, one-time per cert** (described above)
2. **A-alias records** (`ws-{env}`, `api-{env}`, `dev/staging/heediq.com`) — **automated** by `Route53AliasRecord` on each stack deploy

### DNS record status (dev)

| Record | Status |
|---|---|
| `ws-dev.heediq.com` → WebSocket API GW | **Created** — Route53AliasRecord ran on WebSocketStack deploy |
| `api-dev.heediq.com` → HTTP API GW | **Created** — Route53AliasRecord ran on ApiStack deploy |
| `dev.heediq.com` → CloudFront | **Created** — Route53AliasRecord ran on WebStack deploy (2026-06-26). Accessible. |

### DNS record status (staging / prod)

| Record | Status |
|---|---|
| All records | **Not created** — environments not yet deployed |

See [Setting up a new environment from scratch](#setting-up-a-new-environment-from-scratch) for the full step-by-step.

---

## Setting up a new environment from scratch

This is the canonical playbook for deploying Heediq infrastructure to a brand-new AWS workload account (staging or prod). Run through this in order — every step depends on the previous one.

### Account IDs and profiles

| Environment | Account ID | AWS profile |
|---|---|---|
| dev | `276594885933` | `heediq-dev` |
| staging | `475790160542` | `heediq-staging` |
| prod | `438825592314` | `heediq-prod` |

Profiles are configured by `scripts/setup-aws-profiles.sh`. SharedServicesStack was deployed once and is already live — do not redeploy it.

### Prerequisites (one-time per machine)

```bash
# 1. Configure AWS SSO profiles for all 4 accounts
bash scripts/setup-aws-profiles.sh

# 2. Log in to all accounts
aws sso login --profile heediq-shared
aws sso login --profile heediq-staging   # or heediq-prod

# 3. Bootstrap CDK in the new account (safe to run multiple times — idempotent)
bash scripts/setup.sh
```

`scripts/setup.sh` also creates the OIDC trust for GitHub Actions and the per-service deploy roles. It must run before CI can deploy to the new account.

### Step 1 — Create prerequisite secrets (before deploying any stack)

These must exist before the stacks that need them are deployed. Creating them with placeholder values first allows the CDK deploy to succeed; replace placeholders with real credentials before any traffic flows.

```bash
# Auth secrets (required by FoundationStack — Cognito IdP triggers)
aws secretsmanager create-secret --name /heediq/auth/google-client-secret \
  --secret-string "placeholder" --profile heediq-staging

aws secretsmanager create-secret --name /heediq/auth/microsoft-client-secret \
  --secret-string "placeholder" --profile heediq-staging

aws ssm put-parameter --name /heediq/auth/google-client-id \
  --value "placeholder" --type String --profile heediq-staging

aws ssm put-parameter --name /heediq/auth/microsoft-client-id \
  --value "placeholder" --type String --profile heediq-staging

# Microsoft OIDC discovery — must be a real URL, not "placeholder"
aws ssm put-parameter --name /heediq/auth/microsoft-issuer-url \
  --value "https://login.microsoftonline.com/organizations/v2.0" \
  --type String --profile heediq-staging

# Summarization Lambda secret (required before Lambda cold-starts)
aws secretsmanager create-secret --name /heediq/summarization/anthropic-api-key \
  --secret-string "placeholder" --profile heediq-staging
```

Replace `heediq-staging` with `heediq-prod` for the prod account. Replace placeholders with real values when you have them (D-032, D-020).

### Step 2 — Deploy FoundationStack

```bash
cd /path/to/heediq-infra
pnpm run cdk deploy HeediqFoundationStack -c env=staging --profile heediq-staging
```

This creates the 5 DynamoDB tables, S3 buckets, SQS queues, Cognito user pool, SSM params, and — critically — the **ACM wildcard cert** for `*.heediq.com` in eu-west-1. The cert enters `PENDING_VALIDATION` status and CDK waits.

### Step 3 — Add the ACM cert validation CNAME to Route 53 ⚠️ (manual, one-time)

While CDK is waiting for the cert, open a new terminal and add the validation CNAME:

**3a — Get the cert ARN from CloudFormation outputs:**
```bash
aws cloudformation describe-stacks \
  --stack-name HeediqFoundationStack \
  --profile heediq-staging \
  --query "Stacks[0].Outputs[?OutputKey=='WildcardCertArn'].OutputValue" \
  --output text
```

**3b — Get the validation CNAME from ACM:**
```bash
aws acm describe-certificate \
  --certificate-arn <WildcardCertArn from step 3a> \
  --profile heediq-staging \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
```

Output looks like:
```json
{ "Name": "_<hex>.heediq.com.", "Type": "CNAME", "Value": "_<hex>.acm-validations.aws." }
```

**3c — Add the CNAME to Route 53 in shared-services** (the hosted zone lives there, not in the workload account):
```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id Z0875312RP7WHSNW7AUM \
  --profile heediq-shared \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "_<hex>.heediq.com.",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "_<hex>.acm-validations.aws."}]
      }
    }]
  }'
```

The cert validates in ~5–10 minutes. CDK's CloudFormation wait will unblock automatically. This CNAME is permanent and idempotent — the `UPSERT` action is safe to run again.

> **Why this is manual:** ACM issues a unique validation CNAME per cert request. Two certs for `*.heediq.com` (one in dev, one in staging) get different CNAMEs. Since Route 53 is in the shared-services account, the workload CDK deploy can't add records there directly — the Route53AliasRecord custom resource handles regular A-alias records via cross-account role assumption, but cert CNAME addition has not been automated. It is a one-time step per new environment. If FoundationStack is ever destroyed and recreated, a new cert with a new CNAME is issued — repeat this step.

### Step 3b — Deploy WorkloadCfCertStack and add its CNAME ⚠️ (manual, one-time)

After FoundationStack is ISSUED, deploy the CloudFront cert stack (us-east-1):

```bash
pnpm run cdk deploy HeediqWorkloadCfCertStack -c env=staging --profile heediq-staging
```

This creates a second ACM cert for `*.heediq.com` in **us-east-1**. It also enters `PENDING_VALIDATION` and needs its own unique CNAME — different from the eu-west-1 CNAME added above.

**Get the cert ARN:**
```bash
aws cloudformation describe-stacks \
  --stack-name HeediqWorkloadCfCertStack \
  --region us-east-1 \
  --profile heediq-staging \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontCertArn'].OutputValue" \
  --output text
```

**Get its validation CNAME:**
```bash
aws acm describe-certificate \
  --certificate-arn <CloudFrontCertArn from above> \
  --region us-east-1 \
  --profile heediq-staging \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
```

**Add the CNAME to Route 53 in shared-services** (same zone, same pattern as Step 3):
```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id Z0875312RP7WHSNW7AUM \
  --profile heediq-shared \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "_<hex-us-east-1>.heediq.com.",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "_<hex-us-east-1>.acm-validations.aws."}]
      }
    }]
  }'
```

Wait ~5–10 minutes for this cert to become ISSUED before proceeding.

### Step 4 — Deploy remaining stacks

Once both certs are ISSUED, deploy all service stacks:

```bash
pnpm run cdk deploy --all -c env=staging --profile heediq-staging \
  --require-approval never
```

This deploys in dependency order. Each stack with a custom domain (`WebSocketStack`, `ApiStack`, `WebStack`) will invoke the `Route53AliasRecord` custom resource Lambda, which assumes `heediq-route53-dns-manager` in shared-services and creates the A-alias record automatically. **No manual DNS step needed for these.**

Verify DNS records were created:
```bash
dig ws-staging.heediq.com A +short
dig api-staging.heediq.com A +short
dig staging.heediq.com A +short   # CloudFront A-alias (or dev.heediq.com / heediq.com for other envs)
```

All should resolve within a few minutes. The CloudFront domain may take longer to propagate globally.

### Step 5 — Set real secrets

Replace placeholder values with actual credentials:

```bash
# Google OAuth (from Google Cloud Console → OAuth 2.0 credentials)
aws ssm put-parameter --name /heediq/auth/google-client-id \
  --value "<real-id>" --type String --overwrite --profile heediq-staging
aws secretsmanager put-secret-value --secret-id /heediq/auth/google-client-secret \
  --secret-string "<real-secret>" --profile heediq-staging

# Microsoft OAuth (from Azure portal → App registrations)
aws ssm put-parameter --name /heediq/auth/microsoft-client-id \
  --value "<real-id>" --type String --overwrite --profile heediq-staging
aws ssm put-parameter --name /heediq/auth/microsoft-issuer-url \
  --value "https://login.microsoftonline.com/<tenant-id>/v2.0" \
  --type String --overwrite --profile heediq-staging
aws secretsmanager put-secret-value --secret-id /heediq/auth/microsoft-client-secret \
  --secret-string "<real-secret>" --profile heediq-staging

# Anthropic API key (from Anthropic console)
aws secretsmanager put-secret-value --secret-id /heediq/summarization/anthropic-api-key \
  --secret-string "<real-key>" --profile heediq-staging
```

### Step 6 — Verify the deployment

```bash
# Check SSM params were created by the stacks
aws ssm get-parameters-by-path --path /heediq --recursive \
  --query "Parameters[].{Name:Name}" --profile heediq-staging

# Expected count: ~22 params (foundation: 14, api: 2, websocket: 2, summarization: 3, web: 2)
# Plus /heediq/infra/cert-arn-us-east-1 in us-east-1 (separate region — check separately)

# Confirm both certs are ISSUED
aws acm list-certificates --profile heediq-staging \
  --query "CertificateSummaryList[?DomainName=='*.heediq.com']"          # eu-west-1

aws acm list-certificates --profile heediq-staging --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='*.heediq.com']"          # us-east-1

# Confirm Route 53 A-alias records exist
dig ws-staging.heediq.com A +short
dig api-staging.heediq.com A +short
dig staging.heediq.com A +short
```

---

## Testing

```bash
pnpm test            # run CDK unit tests (Vitest + aws-cdk-lib/assertions)
pnpm test:pre-pr     # typecheck + unit tests (the pre-PR gate)
```

Tests live in `test/`. Each stack gets its own `*.test.ts` file. CDK unit tests use `Template.fromStack()` to assert CloudFormation resource properties without deploying. No AWS credentials needed.

## Scripts

All scripts are **infra owner / admin only**. Regular developers do not run these.

| Script | Purpose |
|---|---|
| `scripts/setup-aws-profiles.sh` | Configure AWS SSO profiles for all 4 accounts. Run once on a new machine. |
| `scripts/setup.sh` | One-time CDK bootstrap + OIDC providers + IAM roles. Run after profile setup. Idempotent. |
| `scripts/setup-budgets.sh` | Creates $50/month cost budgets for the dev account via the management account. |

`setup-budgets.sh` additionally requires the `heediq-management` SSO profile:

```bash
aws configure sso --profile heediq-management
# SSO start URL → from IAM Identity Center in management account
# SSO region    → eu-west-1

aws sso login --profile heediq-management
bash scripts/setup-budgets.sh
```

## Gotchas

- **CloudFront ACM cert must be in `us-east-1`** (D-053) — CloudFront only trusts certificates from that region, regardless of where the distribution is. CDK handles this via a cross-region stack.

- **S3 bucket names append `${Aws.ACCOUNT_ID}`** — S3 namespace is globally unique across all AWS accounts so D-037's no-prefix rule can't apply. App repos always read the bucket name from SSM; never hardcode it.

- **OIDC trust policy `sub` must be a wildcard** — use `repo:heediq/heediq-infra:*` with `StringLike`. Locking to a branch (`ref:refs/heads/develop`) blocks PRs and feature-branch synths. Re-run `scripts/setup.sh` if the trust policy drifts (idempotent).

- **Cognito OIDC IdPs validate the issuer URL at deploy time** — CloudFormation calls `{issuerUrl}/.well-known/openid-configuration` when creating `AWS::Cognito::UserPoolIdentityProvider`. Placeholder tenant IDs (e.g. `placeholder` in a Microsoft URL) cause deploy failure. Use `https://login.microsoftonline.com/organizations/v2.0` as the placeholder until a real Azure tenant is registered.

- **Cross-account email sending via role assumption** (D-058) — SES identity lives in shared-services account. Workload Lambdas assume `arn:aws:iam::313828097088:role/heediq-ses-email-sending` (stored in SSM `/heediq/api/ses-sending-role-arn`) and call SES in `eu-west-1` using those credentials. Do NOT create SES identities in workload accounts — DKIM CNAMEs would require a cross-account Route 53 update, creating a dependency from shared-services on environment stacks.

- **Security group `description` must be ASCII only** — AWS EC2 rejects non-ASCII characters (e.g. em dashes `—`) in `GroupDescription` with a 400 error at deploy time. Use plain hyphens `-` in all security group descriptions.

- **CDK S3 event notifications use a Lambda-backed custom resource** — `bucket.addEventNotification()` does not emit `AWS::S3::BucketNotification`. The verifiable contract in CDK unit tests is the `AWS::SQS::QueuePolicy` granting `s3.amazonaws.com` SendMessage permission.

- **`cdk.context.json` must include AZ entries for each workload account** — `ec2.Vpc` in an environment-bound stack triggers an AZ lookup. Without a cache entry, `cdk synth` fails in CI (which has no AWS credentials in the `validate` job, D-043). The file is committed with `eu-west-1a/b/c` for dev/staging/prod accounts. If an account is re-created or a new account is added, append the corresponding entry. Values: `"availability-zones:account=<id>:region=eu-west-1": ["eu-west-1a", "eu-west-1b", "eu-west-1c"]`

- **Cross-account ECR pull from `fromRegistry` triggers a CDK warning** — `ContainerImage.fromRegistry(ecrUri)` on a cross-account ECR URI produces `[Warning] Proper policies need to be attached before pulling from ECR repository, or use 'fromEcrRepository'`. This is expected: `fromEcrRepository` only works for same-account repos. The explicit IAM statements on the execution role (plus the repo resource policy in SharedServicesStack) provide the correct cross-account access. The warning is harmless.
