#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNTS, AWS_REGION, CERT_REGION, WorkloadEnv } from '../lib/config';
import { SharedServicesStack } from '../lib/shared-services/shared-services-stack';
import { SharedServicesCfCertStack } from '../lib/shared-services/shared-services-cf-cert-stack';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { ApiStack } from '../lib/api/api-stack';
import { WorkloadCfCertStack } from '../lib/web/workload-cf-cert-stack';
import { WebStack } from '../lib/web/web-stack';
import { TranscriptionStack } from '../lib/transcription/transcription-stack';
import { SummarizationStack } from '../lib/summarization/summarization-stack';
import { WebSocketStack } from '../lib/websocket/websocket-stack';

const app = new cdk.App();
const targetEnv = app.node.tryGetContext('env') as WorkloadEnv | 'shared' | undefined;

if (!targetEnv) {
  throw new Error('Required: -c env=<shared|dev|staging|prod>');
}

if (targetEnv === 'shared') {
  // crossRegionReferences: true lets CDK pass the hosted zone construct from eu-west-1
  // to the us-east-1 cert stack automatically via SSM-backed cross-region references.
  const sharedStack = new SharedServicesStack(app, 'HeediqSharedServicesStack', {
    env: { account: ACCOUNTS.sharedServices, region: AWS_REGION },
    terminationProtection: true,
    crossRegionReferences: true,
  });

  new SharedServicesCfCertStack(app, 'HeediqSharedServicesCfCertStack', {
    env: { account: ACCOUNTS.sharedServices, region: CERT_REGION },
    terminationProtection: true,
    crossRegionReferences: true,
    hostedZone: sharedStack.hostedZone,
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

  // ACM cert for CloudFront — must be in us-east-1 (D-053).
  // crossRegionReferences: true enables CDK's SSM-backed cross-region parameter exchange
  // so the cert ARN flows from this us-east-1 stack to the eu-west-1 WebStack as a prop.
  const workloadCfCertStack = new WorkloadCfCertStack(app, 'HeediqWorkloadCfCertStack', {
    env: { account: ACCOUNTS[workloadEnv], region: CERT_REGION },
    terminationProtection,
    crossRegionReferences: true,
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

  new WebSocketStack(app, 'HeediqWebSocketStack', {
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
    crossRegionReferences: true, // receives cfCert prop from us-east-1 WorkloadCfCertStack
    foundation,
    cfCert: workloadCfCertStack.cfCert,
  });
}
