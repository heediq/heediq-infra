export const AWS_REGION = 'eu-west-1';
export const CERT_REGION = 'us-east-1'; // CloudFront ACM certs must be in us-east-1 (D-053)

export const ACCOUNTS = {
  sharedServices: '313828097088', // D-045
  dev:            '276594885933', // D-045
  staging:        '475790160542', // D-045
  prod:           '438825592314', // D-045
} as const;

export type WorkloadEnv = 'dev' | 'staging' | 'prod';

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
} as const;

// D-055 — all environments use identical sizing at launch; scale when metrics demand it
export const COMPUTE = {
  lambda: {
    api:           { memoryMB: 512, timeoutSecs: 30  },
    summarization: { memoryMB: 512, timeoutSecs: 300 },
  },
  fargate: {
    free: { cpu: 1024, memoryMiB: 2048 }, // 1 vCPU, 2 GB — whisper small CPU
    paid: { cpu: 4096, memoryMiB: 8192 }, // 4 vCPU, 8 GB — whisper large-v3 + pyannote CPU
  },
} as const;
