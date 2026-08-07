import { describe, it, expect } from 'vitest';
import { taskDefForTier, buildRunTaskInput } from '../lib/transcription/dispatcher/routing.mjs';

const ENV = {
  CLUSTER_ARN: 'arn:aws:ecs:eu-west-1:276594885933:cluster/heediq-transcription',
  CAPACITY_PROVIDER: 'heediq-transcription-ec2',
  CONTAINER_NAME: 'heediq-transcription-worker',
  FREE_TASK_DEF_FAMILY: 'heediq-transcription-free',
  PAID_TASK_DEF_FAMILY: 'heediq-transcription-paid',
};

describe('taskDefForTier', () => {
  it('maps free → free family', () => {
    expect(taskDefForTier('free', { free: 'F', paid: 'P' })).toBe('F');
  });

  it('maps paid → paid family', () => {
    expect(taskDefForTier('paid', { free: 'F', paid: 'P' })).toBe('P');
  });

  it('throws on an unknown tier — the message goes to retry/DLQ rather than the wrong worker', () => {
    expect(() => taskDefForTier('gold', { free: 'F', paid: 'P' })).toThrow(/unknown tier/);
    expect(() => taskDefForTier(undefined, { free: 'F', paid: 'P' })).toThrow(/unknown tier/);
  });
});

describe('buildRunTaskInput', () => {
  it('routes a paid job to the paid family with the raw body as SQS_MESSAGE_BODY override', () => {
    const body = JSON.stringify({ jobId: 'j-1', tier: 'paid', model: 'large-v3' });
    const input = buildRunTaskInput(body, ENV);

    expect(input.cluster).toBe(ENV.CLUSTER_ARN);
    expect(input.taskDefinition).toBe('heediq-transcription-paid');
    expect(input.count).toBe(1);
    expect(input.capacityProviderStrategy).toEqual([
      { capacityProvider: 'heediq-transcription-ec2', weight: 1 },
    ]);
    expect(input.overrides.containerOverrides).toEqual([
      {
        name: 'heediq-transcription-worker',
        environment: [{ name: 'SQS_MESSAGE_BODY', value: body }],
      },
    ]);
  });

  it('routes a free job to the free family', () => {
    const body = JSON.stringify({ jobId: 'j-2', tier: 'free' });
    expect(buildRunTaskInput(body, ENV).taskDefinition).toBe('heediq-transcription-free');
  });

  it('passes the body through byte-for-byte (no re-serialization)', () => {
    const body = '{"jobId":"j-3","tier":"free","extra":"  spaced  "}';
    const input = buildRunTaskInput(body, ENV);
    expect(input.overrides.containerOverrides[0].environment[0].value).toBe(body);
  });
});
