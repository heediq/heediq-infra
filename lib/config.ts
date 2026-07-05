import * as logs from 'aws-cdk-lib/aws-logs';

export const AWS_REGION = 'eu-west-1';
export const CERT_REGION = 'us-east-1'; // CloudFront ACM certs must be in us-east-1 (D-053)

export const ACCOUNTS = {
  sharedServices: '313828097088', // D-045
  dev:            '276594885933', // D-045
  staging:        '475790160542', // D-045
  prod:           '438825592314', // D-045
} as const;

export type WorkloadEnv = 'dev' | 'staging' | 'prod';

// D-093: every Lambda/log-producing resource must set an explicit CloudWatch Logs retention —
// "Never Expire" (the CDK default when no LogGroup/logRetention is configured) is disallowed.
// 30 days is enough for dev/staging debugging; prod keeps 90 days for longer incident lookback.
export function logRetentionFor(workloadEnv: WorkloadEnv): logs.RetentionDays {
  return workloadEnv === 'prod' ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH;
}

export const DOMAINS = {
  root: 'heediq.com',
  web: {
    prod:    'heediq.com',
    staging: 'staging.heediq.com',
    dev:     'dev.heediq.com',
  } satisfies Record<WorkloadEnv, string>,
  api: {
    prod:    'api.heediq.com',
    staging: 'api-staging.heediq.com',
    dev:     'api-dev.heediq.com',
  } satisfies Record<WorkloadEnv, string>,
  ws: {
    prod:    'ws.heediq.com',
    staging: 'ws-staging.heediq.com',
    dev:     'ws-dev.heediq.com',
  } satisfies Record<WorkloadEnv, string>,
} as const;

// Populated after SharedServicesStack first deploy.
export const SHARED_SERVICES = {
  hostedZoneId: 'Z0875312RP7WHSNW7AUM',
  // Cert ARNs are NOT stored here — certs live in each workload account (FoundationStack)
  // so API Gateway and CloudFront can reference them same-account (D-053).
  // eu-west-1 wildcard cert: FoundationStack.wildcardCert (passed as CDK prop, D-063)
  // us-east-1 wildcard cert: WorkloadCfCertStack → WebStack via crossRegionReferences (D-053)
} as const;

// Email — Zoho EU. DKIM key: Zoho Admin Console → Email → Email Authentication → DKIM.
// Leave zohoDkimKey empty until retrieved; the stack skips the DKIM record until it's set.
export const EMAIL = {
  zohoDkimKey: 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCGr9b9Y2d9Be+M8Q1AaeXUfI7ofWZSCNiS8b2Y2VtpyyO0OtkLa2ORZ7wujPFfCIRhNumqRl7f9qUT04qqydkL8/76kbjCHvgD/JobYIw6VhJ5WJ72lll0MMvvGgWS07QHwMQDMLNNBJ7eC4a6GH25FDGYb/1g2e7+udzwZRp+XwIDAQAB', // e.g. "v=DKIM1; k=rsa; p=<key>"
} as const;

// D-055 / D-059 — all environments use identical sizing at launch; scale when metrics demand it
export const COMPUTE = {
  lambda: {
    api:            { memoryMB: 512, timeoutSecs: 30  },
    summarization:  { memoryMB: 512, timeoutSecs: 300 },
    // Fires on every token issuance (D-077) — must stay fast, well under Cognito's 5s trigger timeout
    authProvision:  { memoryMB: 256, timeoutSecs: 5   },
    // PreSignUp/PostConfirmation/PostAuthentication (D-087) — same 5s Cognito trigger budget
    authTrigger:    { memoryMB: 256, timeoutSecs: 5   },
  },
  // D-059: EC2 GPU Spot (g4dn.xlarge). One ASG, one capacity provider — both tiers share the pool.
  // Model choice (free=small / paid=large-v3+pyannote) is enforced at API layer (D-060).
  gpu: {
    instanceType: 'g4dn.xlarge',           // smallest CUDA instance on AWS; 1 T4 GPU, 4 vCPU, 16 GB RAM
    free: { cpu: 1024, memoryMiB: 2048 }, // 1 vCPU / 2 GB reserved — whisper small
    paid: { cpu: 4096, memoryMiB: 8192 }, // 4 vCPU / 8 GB reserved — whisper large-v3 + pyannote
  },
} as const;
