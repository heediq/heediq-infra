import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthDevTemplate } from './test-utils';

describe('FoundationStack — auth Lambda triggers (dev)', () => {
  let template: Template;

  beforeAll(() => {
    template = synthDevTemplate();
  });

  it('wires the auth-provision Lambda as the PreTokenGeneration trigger (D-077)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: Match.objectLike({
        PreTokenGeneration: Match.anyValue(),
      }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-auth-provision',
      Environment: {
        Variables: Match.objectLike({
          ORGS_TABLE_NAME: Match.anyValue(),
          USERS_TABLE_NAME: Match.anyValue(),
          ROLES_TABLE_NAME: Match.anyValue(),
          GROUPS_TABLE_NAME: Match.anyValue(),
          ROLE_ASSIGNMENTS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('wires the 3 cross-provider linking triggers (D-087)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: Match.objectLike({
        PreSignUp: Match.anyValue(),
        PostConfirmation: Match.anyValue(),
        PostAuthentication: Match.anyValue(),
      }),
    });
    for (const functionName of [
      'heediq-auth-trigger-pre-signup',
      'heediq-auth-trigger-post-confirmation',
      'heediq-auth-trigger-post-authentication',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: functionName });
    }
  });

  it('pre-signup and post-authentication triggers get least-privilege Cognito IAM, scoped to account/region not `*`', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'PreSignUpCognitoAccess',
            Action: Match.arrayWith(['cognito-idp:AdminLinkProviderForUser']),
            Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
          }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'PostAuthenticationCognitoAccess',
            Action: Match.arrayWith(['cognito-idp:AdminLinkProviderForUser']),
            Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
          }),
        ]),
      }),
    });
  });
});
