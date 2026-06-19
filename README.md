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
- `lib/shared-services/shared-services-stack.ts` — ECR, Route 53, ACM certs
- `lib/foundation/foundation-stack.ts` — DynamoDB, S3, SQS, Cognito, SES (per workload account)
- `lib/api/api-stack.ts` — Lambda (Hono API) + API Gateway
- `lib/web/web-stack.ts` — S3 + CloudFront (PWA hosting)
- `lib/transcription/transcription-stack.ts` — ECS cluster + Fargate task definitions
- `lib/summarization/summarization-stack.ts` — Lambda (Claude extraction worker)
- `.github/workflows/deploy.yml` — CI/CD pipeline

## Stack Map

| Stack | Account | Region | Notes |
|---|---|---|---|
| `HeediqSharedServicesStack` | `313828097088` | eu-west-1 | ECR, Route 53, ACM cert |
| `HeediqSharedServicesCfCertStack` | `313828097088` | us-east-1 | ACM cert for CloudFront (must be us-east-1) |
| `HeediqFoundationStack` | per env | eu-west-1 | DynamoDB, S3, SQS, Cognito, SES |
| `HeediqApiStack` | per env | eu-west-1 | Lambda + API Gateway |
| `HeediqWebStack` | per env | eu-west-1 | CloudFront + S3 |
| `HeediqTranscriptionStack` | per env | eu-west-1 | ECS cluster + Fargate task defs |
| `HeediqSummarizationStack` | per env | eu-west-1 | Lambda (Claude extraction worker) |

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
| Pull request | `pnpm typecheck` + `cdk synth --all -c env=dev` (no AWS calls) |
| Push to `develop` (non-shared-services files) | Deploy all workload stacks to dev |
| Push to `main` | Deploy to staging → manual approval → deploy to prod |

**`deploy-shared-services.yml`** — shared-services account only:

| Event | Action |
|---|---|
| Push to `develop` (`lib/shared-services/**` or `bin/infra.ts`) | Deploy both shared-services stacks |
| `workflow_dispatch` | Force re-deploy (escape hatch) |

Shared-services never deploys from `main` — it has no dev/staging/prod split. `deploy.yml` ignores `lib/shared-services/**` changes so a shared-services-only push doesn't trigger a no-op workload deploy.

OIDC role assumed per account — no stored AWS credentials (D-036).

## Local Development

```bash
pnpm install
pnpm typecheck                         # type-check only
pnpm cdk synth -c env=dev              # synthesize dev stacks (no AWS needed)
pnpm cdk diff -c env=dev               # diff against deployed dev (needs AWS creds)
pnpm cdk deploy --all -c env=dev       # deploy all dev stacks
```

Use the local AWS CLI profile for the target account (D-045):

| Env | Profile |
|---|---|
| shared-services | `heediq-shared` |
| dev | `heediq-dev` |
| staging | `heediq-staging` |
| prod | `heediq-prod` |

## Initial Setup (one-time)

The setup has a fixed order — shared-services must be fully deployed and `lib/config.ts` filled before any workload environment (dev/staging/prod) can deploy. Workload stacks reference the hosted zone ID and cert ARNs from config.ts.

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

After the deploy completes, capture outputs and fill `lib/config.ts → SHARED_SERVICES`:

```bash
# eu-west-1 outputs
aws cloudformation describe-stacks --stack-name HeediqSharedServicesStack \
  --profile heediq-shared --query "Stacks[0].Outputs"

# us-east-1 cert output
aws cloudformation describe-stacks --stack-name HeediqSharedServicesCfCertStack \
  --profile heediq-shared --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='CertArnUsEast1'].OutputValue" --output text
```

Commit the filled values to develop. Workload CI deploys (dev/staging/prod) will work automatically after this — they read hosted zone ID and cert ARNs from config.ts.

## Contracts

- **SSM param convention**: `/heediq/{service}/{param}` — no environment prefix (D-038)
- **Resource naming**: `heediq-{entity}` — no environment prefix (D-037)
- **Secrets**: never in code or env files; fetched at Lambda cold start via Lambda Extension (D-038)
- **DynamoDB**: `PAY_PER_REQUEST` in all environments (D-055)
- **Compute sizing**: see `lib/config.ts` → `COMPUTE` (D-055)

## Scripts

| Script | Purpose |
|---|---|
| `scripts/setup.sh` | One-time AWS setup: CDK bootstrap + OIDC providers + IAM roles. Run before first deploy. Idempotent. |
| `scripts/setup-budgets.sh` | Creates $50/month cost budgets for the dev account via the management account. |

`setup-budgets.sh` requires the `heediq-management` SSO profile:

```bash
aws configure sso --profile heediq-management
# SSO start URL → from IAM Identity Center in management account
# SSO region    → eu-west-1

aws sso login --profile heediq-management
bash scripts/setup-budgets.sh
```

## Gotchas

- CloudFront ACM cert **must** be provisioned in `us-east-1`, even though all other resources are
  in `eu-west-1` (D-053). This requires a cross-region CDK construct.
- Cross-account Route 53 records (workload accounts writing DNS aliases into the shared-services
  hosted zone) require cross-account IAM grants on the hosted zone.
- `terminationProtection: true` is set on prod stacks — you must disable it manually before
  tearing down prod.
- Always deploy `heediq-infra` before deploying app repos when a change adds new AWS resources
  (D-050). App repos reference resource names via SSM params, not hardcoded ARNs.
- **OIDC trust policy `sub` must use a wildcard ref** — `repo:heediq/heediq-infra:*` with
  `StringLike`. Do NOT lock to a branch (`ref:refs/heads/develop`) — that breaks PRs and
  feature-branch synths. Do NOT use the old org name `admin-heediq`. Run
  `claude-workspace/scripts/setup-aws-oidc.sh` to fix all accounts at once.
