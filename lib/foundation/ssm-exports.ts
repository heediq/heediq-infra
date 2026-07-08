import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

// ── SSM params — resource locators for all app repos (D-038) ─────────────
export function exportSsmParams(scope: Construct, params: Array<[string, string, string]>): void {
  for (const [name, value, description] of params) {
    new ssm.StringParameter(scope, name.replace(/\//g, '-').slice(1), {
      parameterName: name,
      stringValue: value,
      description,
    });
  }
}
