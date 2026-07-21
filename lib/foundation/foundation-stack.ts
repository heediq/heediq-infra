import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { WorkloadEnv, ACCOUNTS } from '../config';
import { createWildcardCert } from './cert';
import { createTables } from './tables';
import { createStorageAndQueues } from './storage';
import { createCognitoSesIdentity } from './ses';
import { createAuthProvisionFn } from './auth-provision-lambda';
import { createAuthLinkingTriggers } from './auth-linking-triggers';
import { createCognitoUserPool } from './cognito';
import { exportSsmParams } from './ssm-exports';

export interface FoundationStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
}

export class FoundationStack extends cdk.Stack {
  readonly workloadEnv: WorkloadEnv;

  // ACM wildcard cert (eu-west-1) — API Gateway and WebSocket custom domains (D-053)
  readonly wildcardCert: acm.Certificate;

  // DynamoDB — multi-table (D-031)
  readonly sourcesTable: dynamodb.Table;
  readonly orgsTable: dynamodb.Table;
  readonly usersTable: dynamodb.Table;
  readonly jobsTable: dynamodb.Table;
  readonly wsConnectionsTable: dynamodb.Table;
  readonly userAuthMethodsTable: dynamodb.Table;
  readonly authAuditLogTable: dynamodb.Table;
  readonly rateLimitsTable: dynamodb.Table;
  readonly cognitoIdentitiesTable: dynamodb.Table;
  readonly rolesTable: dynamodb.Table;
  readonly groupsTable: dynamodb.Table;
  readonly roleAssignmentsTable: dynamodb.Table;
  readonly auditLogTable: dynamodb.Table;

  // Context Library (D-124–D-143)
  readonly contextsTable: dynamodb.Table;
  readonly extractedItemsTable: dynamodb.Table;
  readonly decisionLedgerTable: dynamodb.Table;
  readonly conversationsTable: dynamodb.Table;
  readonly chatMessagesTable: dynamodb.Table;
  readonly contextGrantsTable: dynamodb.Table;

  // S3
  readonly audioUploadsBucket: s3.Bucket;
  readonly webAssetsBucket: s3.Bucket;

  // SQS
  readonly transcriptionQueue: sqs.Queue;

  // Cognito
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    this.workloadEnv = props.workloadEnv;

    const isProd = props.workloadEnv === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    this.wildcardCert = createWildcardCert(this);

    const tables = createTables(this, removalPolicy);
    this.sourcesTable = tables.sourcesTable;
    this.orgsTable = tables.orgsTable;
    this.usersTable = tables.usersTable;
    this.jobsTable = tables.jobsTable;
    this.wsConnectionsTable = tables.wsConnectionsTable;
    this.userAuthMethodsTable = tables.userAuthMethodsTable;
    this.authAuditLogTable = tables.authAuditLogTable;
    this.rateLimitsTable = tables.rateLimitsTable;
    this.cognitoIdentitiesTable = tables.cognitoIdentitiesTable;
    this.rolesTable = tables.rolesTable;
    this.groupsTable = tables.groupsTable;
    this.roleAssignmentsTable = tables.roleAssignmentsTable;
    this.auditLogTable = tables.auditLogTable;
    this.contextsTable = tables.contextsTable;
    this.extractedItemsTable = tables.extractedItemsTable;
    this.decisionLedgerTable = tables.decisionLedgerTable;
    this.conversationsTable = tables.conversationsTable;
    this.chatMessagesTable = tables.chatMessagesTable;
    this.contextGrantsTable = tables.contextGrantsTable;

    const storage = createStorageAndQueues(this, { removalPolicy, isProd });
    this.transcriptionQueue = storage.transcriptionQueue;
    this.audioUploadsBucket = storage.audioUploadsBucket;
    this.webAssetsBucket = storage.webAssetsBucket;

    const authProvisionFn = createAuthProvisionFn(this, tables);
    const sesIdentity = createCognitoSesIdentity(this);

    const { userPool, userPoolDomain, userPoolClient } = createCognitoUserPool(this, {
      workloadEnv: props.workloadEnv,
      removalPolicy,
      authProvisionFn,
      sesIdentity,
    });
    this.userPool = userPool;
    this.userPoolClient = userPoolClient;

    createAuthLinkingTriggers(this, tables, userPool);

    exportSsmParams(this, [
      ['/heediq/api/sources-table-name',     this.sourcesTable.tableName,          'DynamoDB sources table name'],
      ['/heediq/api/orgs-table-name',        this.orgsTable.tableName,             'DynamoDB orgs table name'],
      ['/heediq/api/users-table-name',       this.usersTable.tableName,            'DynamoDB users table name'],
      ['/heediq/api/jobs-table-name',        this.jobsTable.tableName,             'DynamoDB jobs table name'],
      ['/heediq/api/audio-bucket-name',      this.audioUploadsBucket.bucketName,   'S3 audio uploads bucket name'],
      ['/heediq/api/web-assets-bucket-name', this.webAssetsBucket.bucketName,      'S3 web assets bucket name'],
      ['/heediq/api/transcription-queue-url',this.transcriptionQueue.queueUrl,     'SQS transcription queue URL'],
      ['/heediq/api/transcription-queue-arn',this.transcriptionQueue.queueArn,     'SQS transcription queue ARN'],
      ['/heediq/api/cognito-user-pool-id',   this.userPool.userPoolId,             'Cognito User Pool ID'],
      ['/heediq/api/cognito-user-pool-arn',  this.userPool.userPoolArn,            'Cognito User Pool ARN'],
      ['/heediq/api/cognito-client-id',      this.userPoolClient.userPoolClientId, 'Cognito App Client ID'],
      ['/heediq/api/cognito-hosted-ui-domain',    userPoolDomain.baseUrl(),        'Cognito Hosted UI base URL (OAuth authorize/token/logout endpoints)'],
      // Deterministic ARN — role created in SharedServicesStack (D-058)
      ['/heediq/api/ses-sending-role-arn',        `arn:aws:iam::${ACCOUNTS.sharedServices}:role/heediq-ses-email-sending`, 'Cross-account IAM role for SES email sending'],
      ['/heediq/api/ws-connections-table-name',   this.wsConnectionsTable.tableName,              'DynamoDB WebSocket connections table name'],
      ['/heediq/api/roles-table-name',            this.rolesTable.tableName,            'DynamoDB RBAC roles table name (D-102)'],
      ['/heediq/api/groups-table-name',           this.groupsTable.tableName,           'DynamoDB RBAC groups table name (D-102)'],
      ['/heediq/api/role-assignments-table-name', this.roleAssignmentsTable.tableName,  'DynamoDB RBAC role-assignments table name (D-102)'],
      ['/heediq/api/audit-log-table-name',        this.auditLogTable.tableName,         'DynamoDB unified audit-log table name (D-102)'],
      ['/heediq/api/contexts-table-name',         this.contextsTable.tableName,         'DynamoDB Context Library contexts table name (D-141)'],
      ['/heediq/api/extracted-items-table-name',  this.extractedItemsTable.tableName,   'DynamoDB Context Library extracted-items table name (D-135)'],
      ['/heediq/api/decision-ledger-table-name',  this.decisionLedgerTable.tableName,   'DynamoDB Context Library decision-ledger table name (D-136)'],
      ['/heediq/api/conversations-table-name',    this.conversationsTable.tableName,    'DynamoDB Context Library conversations table name (D-138)'],
      ['/heediq/api/chat-messages-table-name',    this.chatMessagesTable.tableName,     'DynamoDB Context Library chat-messages table name (D-138)'],
      ['/heediq/api/context-grants-table-name',   this.contextGrantsTable.tableName,    'DynamoDB Context Library cross-org grants table name (D-142)'],
    ]);
  }
}
