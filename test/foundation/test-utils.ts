import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../../lib/foundation/foundation-stack';

let counter = 0;

// Each caller gets a fresh stack (unique id) so tests can run in parallel files
// without CDK app/construct-id collisions.
export function synthDevTemplate(): Template {
  const app = new cdk.App();
  const stack = new FoundationStack(app, `TestFoundationStack${counter++}`, {
    env: { account: '123456789012', region: 'eu-west-1' },
    workloadEnv: 'dev',
  });
  return Template.fromStack(stack);
}

export function synthProdTemplate(): Template {
  const app = new cdk.App();
  const stack = new FoundationStack(app, `ProdFoundationStack${counter++}`, {
    env: { account: '438825592314', region: 'eu-west-1' },
    workloadEnv: 'prod',
  });
  return Template.fromStack(stack);
}
