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
- `lib/websocket/websocket-stack.ts` — WebSocket API + connection Lambda + Status Pusher Lambda (D-061, planned)
- `lib/summarization/summarization-stack.ts` — Lambda (Claude extraction worker)
- `.github/workflows/deploy.yml` — CI/CD pipeline

## Stack Map

| Stack | Account | Region | Notes |
|---|---|---|---|
| `HeediqSharedServicesStack` | `313828097088` | eu-west-1 | ECR, Route 53, ACM cert, SES identity + DKIM, cross-account email role |
| `HeediqSharedServicesCfCertStack` | `313828097088` | us-east-1 | ACM cert for CloudFront (must be us-east-1) |
| `HeediqFoundationStack` | per env | eu-west-1 | DynamoDB, S3, SQS, Cognito |
| `HeediqApiStack` | per env | eu-west-1 | Lambda + API Gateway |
| `HeediqWebStack` | per env | eu-west-1 | CloudFront + S3 |
| `HeediqTranscriptionStack` | per env | eu-west-1 | ECS cluster + EC2 GPU Spot ASG + task defs (D-059) |
| `HeediqSummarizationStack` | per env | eu-west-1 | Lambda (Claude extraction worker) |
| `HeediqWebSocketStack` | per env | eu-west-1 | WebSocket API + Status Pusher Lambda (D-061, planned) |

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
| Push to `develop` (`lib/shared-services/**` or `bin/infra.ts`) | typecheck + unit tests + synth, then deploy |
| `workflow_dispatch` | Force re-deploy (escape hatch) |

Shared-services never deploys from `main` — it has no dev/staging/prod split. `deploy.yml` ignores `lib/shared-services/**` changes so a shared-services-only push doesn't trigger a no-op workload deploy.

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

This creates: ECR repo, Route 53 hosted zone, ACM cert (eu-west-1), email DNS records, and ACM cert (us-east-1 for CloudFront).

### Step 3 — Update NS records at registrar

Take the `NameServers` output from `HeediqSharedServicesStack` and set them as the domain's authoritative nameservers at the registrar (replace, don't add). ACM cert validation happens automatically once DNS propagates (~10–30 min).

### Step 4 — Fill config.ts and commit

Only `hostedZoneId` needs to be captured — cert ARNs are stored in SSM by the stacks and read at deploy time by workload stacks.

```bash
aws cloudformation describe-stacks --stack-name HeediqSharedServicesStack \
  --profile heediq-shared \
  --query "Stacks[0].Outputs[?OutputKey=='HostedZoneId'].OutputValue" --output text
```

Fill `lib/config.ts → SHARED_SERVICES.hostedZoneId` and commit to develop. Workload CI deploys (dev/staging/prod) will work automatically after this.

Cert ARNs are in SSM (no manual step needed):
- `eu-west-1`: `/heediq/shared/cert-arn-eu-west-1`
- `us-east-1`: `/heediq/shared/cert-arn-us-east-1`

## Contracts

- **SSM param convention**: `/heediq/{service}/{param}` — no environment prefix (D-038)
- **Resource naming**: `heediq-{entity}` — no environment prefix (D-037). **Exception:** S3 bucket names are globally unique, so buckets append the account ID: `heediq-audio-uploads-{accountId}`. App repos always resolve bucket names via SSM, never hardcode them.
- **Secrets**: never in code or env files; fetched at Lambda cold start via Lambda Extension (D-038)
- **DynamoDB**: `PAY_PER_REQUEST` in all environments (D-055)
- **Compute sizing**: see `lib/config.ts` → `COMPUTE` (D-055)

### FoundationStack SSM params (consumed by all app repos)

| SSM path | Value |
|---|---|
| `/heediq/api/recordings-table-name` | `heediq-recordings` |
| `/heediq/api/orgs-table-name` | `heediq-orgs` |
| `/heediq/api/users-table-name` | `heediq-users` |
| `/heediq/api/jobs-table-name` | `heediq-jobs` |
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
| Task def — whisper small | `Ec2TaskDefinition`, `TIER=free` env var, 1 GPU unit resource requirement |
| Task def — whisper large-v3 | `Ec2TaskDefinition`, `TIER=paid` env var, 1 GPU unit resource requirement |
| EventBridge Pipes | `heediq-transcription-free` / `heediq-transcription-paid` — filter on SQS `messageAttributes.tier`; batchSize=1; EC2 capacity provider (D-059) |
| IAM execution role | `heediq-transcription-execution` — cross-account ECR pull (shared-services 313828097088) + CloudWatch Logs write |
| IAM task role | `heediq-transcription-task` — S3 read (audio uploads bucket) + DynamoDB write (heediq-jobs + heediq-recordings) |
| IAM instance role | `heediq-transcription-instance` — ECS agent registration, CloudWatch Logs, SSM agent access |
| IAM pipe role | `heediq-transcription-pipe` — SQS consume + `ecs:RunTask` + `iam:PassRole` |
| ECR image | `313828097088.dkr.ecr.eu-west-1.amazonaws.com/heediq-worker-transcription` (cross-account pull) |

**Message routing (D-059, D-060):** The API enqueues jobs with `messageAttributes.tier = 'free' | 'paid'`. Access to `paid` (large-v3) is enforced at the API enqueue endpoint — free users are rejected if they request it. Each EventBridge Pipe filters on tier and launches the matching task definition. No idle containers — tasks launch on demand, EC2 instance terminates after job completes.

**Spot interruption:** worker catches SIGTERM → writes `status=retrying` to `heediq-jobs` → SQS message re-enqueues on visibility timeout expiry (D-059).

### WebSocketStack resources (D-061, planned)

> **Planned — not yet deployed.** Implementation follows TranscriptionStack GPU migration.

| Resource | Details |
|---|---|
| WebSocket API | API Gateway WebSocket API — `$connect` / `$disconnect` / `$default` routes |
| Connection Lambda | On `$connect`: validates JWT (query param `?token=<jwt>`), stores `connectionId` + `userId` + `orgId` + `recordingId` in `heediq-ws-connections`. On `$disconnect`: removes row. |
| Status Pusher Lambda | Triggered by DDB Streams on `heediq-jobs`; queries `heediq-ws-connections` GSI `by-recording` (PK=`recordingId`); POSTs status payload to each active `connectionId` via `execute-api:ManageConnections`. On `GoneException` (stale connection): deletes row from table. |
| Custom domains | `ws.heediq.com` (prod) / `ws-staging.heediq.com` (staging) / `ws-dev.heediq.com` (dev) — wildcard cert from SSM (D-053) |
| IAM: pusher role | `execute-api:ManageConnections` scoped to WebSocket API ARN |

**Status stages pushed to client:** `queued → starting → transcribing → diarizing (large-v3 only) → summarizing → done / failed`

`starting` is written by the transcription worker as its first DynamoDB update (before model load) — surfaces EC2 cold-start as visible UX state rather than a silent wait.

**New SSM params (to be added in FoundationStack):**

| SSM path | Value |
|---|---|
| `/heediq/api/ws-connections-table-name` | `heediq-ws-connections` |
| `/heediq/api/ws-endpoint-url` | WebSocket API endpoint URL (set post-deploy) |

### FoundationStack DynamoDB key design

| Table | PK | SK | GSIs | Streams |
|---|---|---|---|---|
| `heediq-recordings` | `orgId` | `recordingId` | `by-org-created` (PK=orgId SK=createdAt), `by-user-created` (PK=userId SK=createdAt) | — |
| `heediq-orgs` | `orgId` | — | `by-email-domain` (PK=emailDomain) | — |
| `heediq-users` | `userId` | — | `by-org` (PK=orgId SK=userId) | — |
| `heediq-jobs` | `recordingId` | — | — | **NEW\_IMAGE** (required for D-061 Status Pusher Lambda trigger) |
| `heediq-ws-connections` | `connectionId` | — | `by-recording` (PK=`recordingId`), TTL on `expiresAt` | — |

`heediq-ws-connections` is a **planned addition** (D-061) — not yet deployed. Will be added to FoundationStack alongside WebSocketStack implementation.

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
