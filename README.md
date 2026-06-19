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

## Bootstrap (one-time, per account)

Before first deploy, each account needs CDK bootstrap and the OIDC deploy role.

### 1. Bootstrap CDK

The app entry requires `-c env=` — include it on every `cdk` command, even `bootstrap`.

```bash
# Workload accounts — eu-west-1 only
pnpm cdk bootstrap aws://276594885933/eu-west-1 --profile heediq-dev     -c env=dev
pnpm cdk bootstrap aws://475790160542/eu-west-1 --profile heediq-staging  -c env=dev
pnpm cdk bootstrap aws://438825592314/eu-west-1 --profile heediq-prod     -c env=dev

# Shared-services account — BOTH regions (eu-west-1 for main stacks, us-east-1 for CloudFront cert)
pnpm cdk bootstrap aws://313828097088/eu-west-1 --profile heediq-shared -c env=shared
pnpm cdk bootstrap aws://313828097088/us-east-1 --profile heediq-shared -c env=shared
```

### 2. Create `GitHubActionsDeployRole` in each account

The role must exist in all four accounts (shared-services + dev + staging + prod) before CI can
assume it. Trust policy: `repo:heediq/heediq-infra:*` with `StringLike` on the `sub` claim (wildcard
ref — do not lock to a branch, that breaks PRs and workflow_dispatch).

See `claude-workspace/scripts/setup-aws-oidc.sh` for the creation commands.

### 3. Deploy shared-services first

Trigger the `workflow_dispatch` on `deploy-shared-services.yml` (GitHub Actions UI or CLI):

```bash
gh workflow run deploy-shared-services.yml --repo heediq/heediq-infra --ref develop
```

This provisions ECR, the Route 53 hosted zone, and ACM certs (both regions). After it completes:
- Capture `HostedZoneId`, `CertArnEuWest1`, `CertArnUsEast1` from CloudFormation outputs
- Update NS records at the domain registrar (from the `NameServers` output) — required for ACM validation
- Fill `lib/config.ts` → `SHARED_SERVICES` fields and commit

Workload deploys run normally via CI after shared-services is up.

## Contracts

- **SSM param convention**: `/heediq/{service}/{param}` — no environment prefix (D-038)
- **Resource naming**: `heediq-{entity}` — no environment prefix (D-037)
- **Secrets**: never in code or env files; fetched at Lambda cold start via Lambda Extension (D-038)
- **DynamoDB**: `PAY_PER_REQUEST` in all environments (D-055)
- **Compute sizing**: see `lib/config.ts` → `COMPUTE` (D-055)

## Scripts (one-time setup, not CDK)

| Script | Purpose |
|---|---|
| `scripts/setup-budgets.sh` | Creates $50/month cost budgets for the dev account in the management account. Run once after configuring the `heediq-management` SSO profile. |

### `heediq-management` SSO profile setup (one-time)

```bash
aws configure sso --profile heediq-management
# SSO start URL → from IAM Identity Center in management account
# SSO region    → eu-west-1

aws sso login --profile heediq-management  # run before each script session
```

Then run:
```bash
chmod +x scripts/setup-budgets.sh
./scripts/setup-budgets.sh
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
