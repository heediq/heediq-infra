#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNTS, AWS_REGION, WorkloadEnv } from '../lib/config';
import { SharedServicesStack } from '../lib/shared-services/shared-services-stack';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { ApiStack } from '../lib/api/api-stack';
import { WebStack } from '../lib/web/web-stack';
import { TranscriptionStack } from '../lib/transcription/transcription-stack';
import { SummarizationStack } from '../lib/summarization/summarization-stack';

const app = new cdk.App();
const targetEnv = app.node.tryGetContext('env') as WorkloadEnv | 'shared' | undefined;

if (!targetEnv) {
  throw new Error('Required: -c env=<shared|dev|staging|prod>');
}

if (targetEnv === 'shared') {
  new SharedServicesStack(app, 'HeediqSharedServicesStack', {
    env: { account: ACCOUNTS.sharedServices, region: AWS_REGION },
    terminationProtection: true,
  });
} else {
  const validWorkloadEnvs: WorkloadEnv[] = ['dev', 'staging', 'prod'];
  if (!validWorkloadEnvs.includes(targetEnv as WorkloadEnv)) {
    throw new Error(`Invalid -c env="${targetEnv}". Must be: shared | dev | staging | prod`);
  }

  const workloadEnv = targetEnv as WorkloadEnv;
  const env = { account: ACCOUNTS[workloadEnv], region: AWS_REGION };
  const terminationProtection = workloadEnv === 'prod';

  const foundation = new FoundationStack(app, 'HeediqFoundationStack', {
    env,
    workloadEnv,
    terminationProtection,
  });

  new TranscriptionStack(app, 'HeediqTranscriptionStack', {
    env,
    workloadEnv,
    terminationProtection,
    foundation,
  });

  new SummarizationStack(app, 'HeediqSummarizationStack', {
    env,
    workloadEnv,
    terminationProtection,
    foundation,
  });

  new ApiStack(app, 'HeediqApiStack', {
    env,
    workloadEnv,
    terminationProtection,
    foundation,
  });

  new WebStack(app, 'HeediqWebStack', {
    env,
    workloadEnv,
    terminationProtection,
    foundation,
  });
}
