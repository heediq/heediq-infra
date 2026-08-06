import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

// The public (non-secret) Amplitude project key used by the server-side analytics choke-point
// (D-154). Resolved at deploy from SSM, so the key never lives in source or the CDK app.
export const AMPLITUDE_API_KEY_PARAM = '/heediq/api/amplitude-api-key';

// Returns the `AMPLITUDE_API_KEY` env entry for an emitting Lambda, or `{}` when server analytics
// isn't enabled for this deploy.
//
// **Optional per env (D-154), opt-in via `-c analytics=true`.** The emit helper
// (heediq-api `src/lib/analytics.ts`) cleanly no-ops when the var is absent, so envs that haven't
// provisioned the key just don't pass the flag and deploy unchanged. When enabled, the SSM param
// `/heediq/api/amplitude-api-key` must already exist (infra-first, D-050) — resolving it at deploy
// keeps the latency-sensitive auth triggers off any runtime SSM read (the value is baked into the
// Lambda env, not fetched on the login path).
export function amplitudeApiKeyEnv(scope: Construct): Record<string, string> {
  const flag = scope.node.tryGetContext('analytics');
  if (flag !== true && flag !== 'true') return {};
  return {
    AMPLITUDE_API_KEY: ssm.StringParameter.valueForStringParameter(scope, AMPLITUDE_API_KEY_PARAM),
  };
}
