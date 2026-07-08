import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { COMPUTE } from '../config';
import type { FoundationTables } from './tables';

// ── Auth provisioning Lambda trigger (D-077) ──────────────────────────────
// Fires on every token issuance (native email/password AND federated Google/Microsoft —
// PreTokenGeneration is the only trigger guaranteed to fire for both). Idempotent
// get-or-create of Org+User in DynamoDB, then injects custom:orgId/custom:role claims.
// Real code deployed by heediq-api CI (same pattern as ApiStack.apiFn) — placeholder here.
export function createAuthProvisionFn(scope: Construct, tables: FoundationTables): lambda.Function {
  const authProvisionFn = new lambda.Function(scope, 'AuthProvisionFn', {
    functionName: 'heediq-auth-provision',
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'auth-provision.handler',
    code: lambda.Code.fromInline(
      'exports.handler = async (event) => event;',
    ),
    memorySize: COMPUTE.lambda.authProvision.memoryMB,
    timeout: cdk.Duration.seconds(COMPUTE.lambda.authProvision.timeoutSecs),
    environment: {
      ORGS_TABLE_NAME: tables.orgsTable.tableName,
      USERS_TABLE_NAME: tables.usersTable.tableName,
      COGNITO_IDENTITIES_TABLE_NAME: tables.cognitoIdentitiesTable.tableName,
      USER_AUTH_METHODS_TABLE_NAME: tables.userAuthMethodsTable.tableName,
      AUTH_AUDIT_LOG_TABLE_NAME: tables.authAuditLogTable.tableName,
    },
  });
  tables.orgsTable.grantReadWriteData(authProvisionFn);
  tables.usersTable.grantReadWriteData(authProvisionFn);
  tables.cognitoIdentitiesTable.grantReadWriteData(authProvisionFn);
  tables.userAuthMethodsTable.grantReadWriteData(authProvisionFn);
  tables.authAuditLogTable.grantWriteData(authProvisionFn);

  return authProvisionFn;
}
