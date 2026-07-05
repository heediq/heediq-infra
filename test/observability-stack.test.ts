import { describe, it, beforeAll, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ObservabilityStack } from '../lib/observability/observability-stack';

function buildTemplate(workloadEnv: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const account = workloadEnv === 'prod' ? '438825592314' : '123456789012';
  const env = { account, region: 'eu-west-1' };

  const observability = new ObservabilityStack(app, 'TestObservabilityStack', {
    env,
    workloadEnv,
  });

  return Template.fromStack(observability);
}

// DashboardBody is synthesized as an Fn::Join over string literals and Ref tokens (region),
// not a plain string — flatten the literal parts to search across the whole body.
function dashboardBodyText(template: Template): string {
  const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
  const body = Object.values(dashboards)[0].Properties.DashboardBody as {
    'Fn::Join': [string, unknown[]];
  };
  return body['Fn::Join'][1].filter((part): part is string => typeof part === 'string').join('');
}

describe('ObservabilityStack (dev)', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate('dev');
  });

  it('creates a single dashboard named heediq-dev', () => {
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'heediq-dev',
    });
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  it('dashboard body references the API and summarization Lambda function names', () => {
    const body = dashboardBodyText(template);
    expect(body).toContain('heediq-api');
    expect(body).toContain('heediq-summarization');
  });

  it('dashboard body references transcription and summarization queues and DLQs', () => {
    const body = dashboardBodyText(template);
    expect(body).toContain('heediq-transcription');
    expect(body).toContain('heediq-transcription-dlq');
    expect(body).toContain('heediq-summarization-dlq');
  });

  it('dashboard body includes a Logs Insights job-stage funnel query on the transcription log group', () => {
    const body = dashboardBodyText(template);
    expect(body).toContain('/heediq/transcription');
    expect(body).toContain('Job status changed');
  });
});
