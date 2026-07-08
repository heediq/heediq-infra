import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { COMPUTE } from '../config';
import type { FoundationTables } from './tables';

// ── Cross-provider account-linking triggers (D-087) ───────────────────────
// Replicates EmotiXOrg/emotix-infra's proven pattern: explicit Lambda triggers (not
// Cognito's built-in attribute-based auto-link) so linking gets a DynamoDB audit trail
// and a canonical-account-id resolution step (needed for `/auth/methods` to show one
// consistent method list regardless of which session — native or federated — is active).
// Real code deployed by heediq-api CI (same pattern as AuthProvisionFn).
export function createAuthLinkingTriggers(
  scope: Construct,
  tables: FoundationTables,
  userPool: cognito.UserPool,
): void {
  const authTriggerPreSignUpFn = new lambda.Function(scope, 'AuthTriggerPreSignUpFn', {
    functionName: 'heediq-auth-trigger-pre-signup',
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'auth-trigger-pre-signup.handler',
    code: lambda.Code.fromInline('exports.handler = async (event) => event;'),
    memorySize: COMPUTE.lambda.authTrigger.memoryMB,
    timeout: cdk.Duration.seconds(COMPUTE.lambda.authTrigger.timeoutSecs),
    environment: {
      USERS_TABLE_NAME: tables.usersTable.tableName,
      USER_AUTH_METHODS_TABLE_NAME: tables.userAuthMethodsTable.tableName,
      COGNITO_IDENTITIES_TABLE_NAME: tables.cognitoIdentitiesTable.tableName,
    },
  });

  const authTriggerPostConfirmationFn = new lambda.Function(scope, 'AuthTriggerPostConfirmationFn', {
    functionName: 'heediq-auth-trigger-post-confirmation',
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'auth-trigger-post-confirmation.handler',
    code: lambda.Code.fromInline('exports.handler = async (event) => event;'),
    memorySize: COMPUTE.lambda.authTrigger.memoryMB,
    timeout: cdk.Duration.seconds(COMPUTE.lambda.authTrigger.timeoutSecs),
    environment: {
      USERS_TABLE_NAME: tables.usersTable.tableName,
      USER_AUTH_METHODS_TABLE_NAME: tables.userAuthMethodsTable.tableName,
      AUTH_AUDIT_LOG_TABLE_NAME: tables.authAuditLogTable.tableName,
      COGNITO_IDENTITIES_TABLE_NAME: tables.cognitoIdentitiesTable.tableName,
    },
  });

  const authTriggerPostAuthenticationFn = new lambda.Function(scope, 'AuthTriggerPostAuthenticationFn', {
    functionName: 'heediq-auth-trigger-post-authentication',
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'auth-trigger-post-authentication.handler',
    code: lambda.Code.fromInline('exports.handler = async (event) => event;'),
    memorySize: COMPUTE.lambda.authTrigger.memoryMB,
    timeout: cdk.Duration.seconds(COMPUTE.lambda.authTrigger.timeoutSecs),
    environment: {
      USERS_TABLE_NAME: tables.usersTable.tableName,
      USER_AUTH_METHODS_TABLE_NAME: tables.userAuthMethodsTable.tableName,
      AUTH_AUDIT_LOG_TABLE_NAME: tables.authAuditLogTable.tableName,
      COGNITO_IDENTITIES_TABLE_NAME: tables.cognitoIdentitiesTable.tableName,
    },
  });

  for (const fn of [authTriggerPreSignUpFn, authTriggerPostConfirmationFn, authTriggerPostAuthenticationFn]) {
    tables.usersTable.grantReadData(fn);
    tables.userAuthMethodsTable.grantReadWriteData(fn);
    tables.cognitoIdentitiesTable.grantReadWriteData(fn);
  }
  tables.authAuditLogTable.grantWriteData(authTriggerPostConfirmationFn);
  tables.authAuditLogTable.grantWriteData(authTriggerPostAuthenticationFn);

  // pre-signup needs to create/query Cognito users directly (auto-heal + link-lookup);
  // post-authentication needs the same plus AdminLinkProviderForUser. Can't scope to
  // `userPool.userPoolArn` directly: that token creates a CFN dependency back onto
  // the pool resource, which already depends on these functions via addTrigger below —
  // a circular reference CloudFormation rejects. Scoping to account/region instead (one
  // pool per account per D-037, so this is still account/region-scoped, not a bare `*`).
  const userPoolArnPattern = cdk.Stack.of(scope).formatArn({
    service: 'cognito-idp',
    resource: 'userpool',
    resourceName: '*',
  });
  authTriggerPreSignUpFn.addToRolePolicy(new iam.PolicyStatement({
    sid: 'PreSignUpCognitoAccess',
    actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminLinkProviderForUser'],
    resources: [userPoolArnPattern],
  }));
  authTriggerPostAuthenticationFn.addToRolePolicy(new iam.PolicyStatement({
    sid: 'PostAuthenticationCognitoAccess',
    actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminLinkProviderForUser'],
    resources: [userPoolArnPattern],
  }));

  // Wired via addTrigger (not the lambdaTriggers prop) since these functions are
  // declared after pool construction.
  userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, authTriggerPreSignUpFn);
  userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, authTriggerPostConfirmationFn);
  userPool.addTrigger(cognito.UserPoolOperation.POST_AUTHENTICATION, authTriggerPostAuthenticationFn);
}
