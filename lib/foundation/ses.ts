import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import { DOMAINS } from '../config';

// ── SES — heediq.com identity for Cognito's own OTP/confirmation emails (D-095) ──
// Cognito's custom-SES email config requires the identity in the SAME account as the
// User Pool — cross-account SES (the D-058 pattern used for app-initiated Lambda email)
// is not supported by Cognito itself. This identity exists solely so Cognito can send its
// native SignUp/ConfirmSignUp codes (D-087) via real SES instead of its default mailer.
// ON FIRST DEPLOY for each new environment, the 3 DKIM CNAMEs (below, in stack outputs)
// must be manually added to Route 53 in the shared-services account — same one-time,
// per-environment manual step as the ACM wildcard cert (D-063, see cert.ts).
export function createCognitoSesIdentity(scope: Construct): ses.CfnEmailIdentity {
  const sesIdentity = new ses.CfnEmailIdentity(scope, 'CognitoSesEmailIdentity', {
    emailIdentity: DOMAINS.root,
    dkimAttributes: { signingEnabled: true },
  });

  for (let i = 1; i <= 3; i++) {
    const name = (sesIdentity as unknown as Record<string, string>)[`attrDkimDnsTokenName${i}`];
    const value = (sesIdentity as unknown as Record<string, string>)[`attrDkimDnsTokenValue${i}`];
    new cdk.CfnOutput(scope, `CognitoSesDkimCname${i}`, {
      value: `${name} CNAME ${value}`,
      description: `DKIM CNAME ${i}/3 for the Cognito SES identity — add to shared-services Route 53 on first deploy`,
    });
  }

  return sesIdentity;
}
