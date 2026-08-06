import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { WebSocketStack } from '../lib/websocket/websocket-stack';

// ── Server-analytics env wiring (D-154) ──────────────────────────────────────
// The AMPLITUDE_API_KEY env is opt-in per deploy via `-c analytics=true` and must land on exactly
// the three emitting Lambdas (WS pusher + the two auth triggers that emit), never on the non-emitting
// auth triggers, and never at all without the flag. Resolving the SSM param at deploy (not runtime)
// keeps the latency-sensitive auth path off any live SSM read. These tests pin all of that so the
// wiring can't silently drift.

function build(analytics: boolean) {
  const app = new cdk.App({ context: analytics ? { analytics: 'true' } : {} });
  const env = { account: '123456789012', region: 'eu-west-1' };
  const foundation = new FoundationStack(app, 'TestFoundationStack', { env, workloadEnv: 'dev' });
  const ws = new WebSocketStack(app, 'TestWebSocketStack', { env, workloadEnv: 'dev', foundation });
  return { foundation: Template.fromStack(foundation), ws: Template.fromStack(ws) };
}

function hasAmplitudeKey(template: Template, functionName: string): boolean {
  const fns = template.findResources('AWS::Lambda::Function', {
    Properties: {
      FunctionName: functionName,
      Environment: { Variables: Match.objectLike({ AMPLITUDE_API_KEY: Match.anyValue() }) },
    },
  });
  return Object.keys(fns).length > 0;
}

describe('server-analytics env wiring — default (no -c analytics)', () => {
  let foundation: Template;
  let ws: Template;

  beforeAll(() => {
    ({ foundation, ws } = build(false));
  });

  it('never wires AMPLITUDE_API_KEY onto any Lambda when the flag is off', () => {
    for (const [, fn] of Object.entries(foundation.findResources('AWS::Lambda::Function'))) {
      const vars = fn.Properties?.Environment?.Variables ?? {};
      expect(Object.keys(vars)).not.toContain('AMPLITUDE_API_KEY');
    }
    for (const [, fn] of Object.entries(ws.findResources('AWS::Lambda::Function'))) {
      const vars = fn.Properties?.Environment?.Variables ?? {};
      expect(Object.keys(vars)).not.toContain('AMPLITUDE_API_KEY');
    }
  });

  it('still wires SOURCES_TABLE_NAME onto the pusher (analytics-independent)', () => {
    ws.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-ws-status-pusher',
      Environment: { Variables: Match.objectLike({ SOURCES_TABLE_NAME: Match.anyValue() }) },
    });
  });
});

describe('server-analytics env wiring — enabled (-c analytics=true)', () => {
  let foundation: Template;
  let ws: Template;

  beforeAll(() => {
    ({ foundation, ws } = build(true));
  });

  it('wires AMPLITUDE_API_KEY onto exactly the emitting auth triggers, not the others', () => {
    expect(hasAmplitudeKey(foundation, 'heediq-auth-provision')).toBe(true);
    expect(hasAmplitudeKey(foundation, 'heediq-auth-trigger-post-authentication')).toBe(true);
    // Non-emitting triggers must stay off the analytics path.
    expect(hasAmplitudeKey(foundation, 'heediq-auth-trigger-pre-signup')).toBe(false);
    expect(hasAmplitudeKey(foundation, 'heediq-auth-trigger-post-confirmation')).toBe(false);
  });

  it('wires AMPLITUDE_API_KEY onto the WS status pusher', () => {
    expect(hasAmplitudeKey(ws, 'heediq-ws-status-pusher')).toBe(true);
  });

  it('resolves the key from the SSM param at deploy (no runtime SSM read on the auth path)', () => {
    // valueForStringParameter renders as an SSM-typed CFN parameter reference, not a custom-resource
    // lookup — the value is baked into the Lambda env at deploy, so the login-critical trigger never
    // performs a live SSM GetParameter.
    const params = foundation.findParameters('*', { Type: 'AWS::SSM::Parameter::Value<String>' });
    const names = Object.values(params).map((p) => p.Default);
    expect(names).toContain('/heediq/api/amplitude-api-key');
  });
});
