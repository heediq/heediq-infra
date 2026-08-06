import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

// The public (non-secret) Amplitude **project** key. Single source of truth for every consumer —
// heediq-web bakes it into `VITE_AMPLITUDE_API_KEY` at build time and this server choke-point reads
// it here — so client- and server-emitted events land in the same Amplitude project and the D-154
// cross-service join (on `user_id`/`org`/entity ids) actually resolves. Deliberately under a neutral
// `/heediq/analytics/` namespace (not `/heediq/web/` or `/heediq/api/`) since it's shared, not owned
// by either side. Resolved at deploy (never in source/the CDK app).
export const AMPLITUDE_API_KEY_PARAM = '/heediq/analytics/amplitude-api-key';

// Returns the `AMPLITUDE_API_KEY` env entry for an emitting Lambda, or `{}` when server analytics
// isn't enabled for this deploy.
//
// **Optional per env (D-154), opt-in via `-c analytics=true`.** The emit helper
// (heediq-api `src/lib/analytics.ts`) cleanly no-ops when the var is absent, so envs that haven't
// enabled analytics just don't pass the flag and deploy unchanged. When enabled, `AMPLITUDE_API_KEY_PARAM`
// must already exist in that account (infra-first, D-050). `valueForStringParameter` resolves at
// deploy (a missing param fails the CFN deploy, not synth), which also keeps the latency-sensitive
// auth triggers off any runtime SSM read (the value is baked into the Lambda env, not fetched on the
// login path).
export function amplitudeApiKeyEnv(scope: Construct): Record<string, string> {
  const flag = scope.node.tryGetContext('analytics');
  if (flag !== true && flag !== 'true') return {};
  return {
    AMPLITUDE_API_KEY: ssm.StringParameter.valueForStringParameter(scope, AMPLITUDE_API_KEY_PARAM),
  };
}
