import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthDevTemplate } from './test-utils';

describe('FoundationStack — Cognito (dev)', () => {
  let template: Template;

  beforeAll(() => {
    template = synthDevTemplate();
  });

  it('creates User Pool with email alias and auto-verification', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      UserPoolName: 'heediq-users',
    });
  });

  // Regression for OTP non-delivery: with no `email:` config, Cognito silently falls back to
  // its own default mailer instead of SES — confirmation codes were never actually reaching
  // real inboxes reliably. The User Pool must declare EmailConfiguration with SES as the
  // source, not leave it unset (D-095).
  it('wires the User Pool to send email via SES, not Cognito\'s default mailer (D-095)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: Match.objectLike({
        EmailSendingAccount: 'DEVELOPER',
        From: Match.stringLikeRegexp(`^Heediq <noreply@heediq\\.com>$`),
      }),
    });
  });

  it('creates a same-account SES identity for heediq.com with DKIM signing (D-095)', () => {
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'heediq.com',
      DkimAttributes: { SigningEnabled: true },
    });
  });

  it('creates Cognito hosted domain with env prefix', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'heediq-dev',
    });
  });

  it('creates Google and Microsoft IdP providers', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 2);
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'Google',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'OIDC',
      ProviderName: 'Microsoft',
    });
  });

  it('User Pool client includes localhost callback URLs for dev', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['http://localhost:5173/auth/callback']),
      LogoutURLs: Match.arrayWith(['http://localhost:5173']),
    });
  });

  it('User Pool client registers the settings link-callback URL (D-083)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith([
        Match.stringLikeRegexp('/settings/link-callback$'),
      ]),
    });
  });

  it('User Pool client has no secret (public browser client)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  it('User Pool defines custom:orgId and custom:role attributes', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'orgId', Mutable: true }),
        Match.objectLike({ Name: 'role', Mutable: true }),
      ]),
    });
  });

  it('User Pool defines custom:permissions and custom:rbacVersion attributes (D-102 Phase 3)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'permissions', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'rbacVersion', AttributeDataType: 'Number', Mutable: true }),
      ]),
    });
  });
});
