import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { WorkloadEnv, DOMAINS, ACCOUNTS, COMPUTE } from '../config';

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

    // ── ACM wildcard cert (eu-west-1) — API Gateway + WebSocket custom domains (D-053, D-063) ──
    // Cert must live in this workload account — API Gateway rejects cross-account certs.
    // IMPORTANT: ACM generates a unique validation CNAME per cert request (not per domain).
    // On FIRST deploy for each new environment, the CNAME for THIS cert must be manually added
    // to Route 53 in the shared-services account. See heediq-infra/README.md → Domains section.
    // ACM auto-renews using the same CNAME — the manual step is truly one-time per cert.
    this.wildcardCert = new acm.Certificate(this, 'WildcardCert', {
      domainName: `*.${DOMAINS.root}`,
      subjectAlternativeNames: [DOMAINS.root],
      validation: acm.CertificateValidation.fromDns(),
    });

    new ssm.StringParameter(this, 'WildcardCertArnParam', {
      parameterName: '/heediq/infra/cert-arn-eu-west-1',
      stringValue: this.wildcardCert.certificateArn,
      description: 'ACM wildcard cert ARN (eu-west-1) — API Gateway and WebSocket custom domains',
    });

    new cdk.CfnOutput(this, 'WildcardCertArn', {
      value: this.wildcardCert.certificateArn,
      description: 'ACM wildcard cert (eu-west-1) for API Gateway and WebSocket custom domains',
    });

    // ── DynamoDB — multi-table, PAY_PER_REQUEST, PITR on all (D-031, D-055, D-021) ──

    this.sourcesTable = new dynamodb.Table(this, 'SourcesTable', {
      tableName: 'heediq-sources',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });
    // Admin list: all org sources, time-sorted
    this.sourcesTable.addGlobalSecondaryIndex({
      indexName: 'by-org-created',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });
    // Member view: own sources, time-sorted (D-021 row-level isolation)
    this.sourcesTable.addGlobalSecondaryIndex({
      indexName: 'by-user-created',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    this.orgsTable = new dynamodb.Table(this, 'OrgsTable', {
      tableName: 'heediq-orgs',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });
    // Email-domain match for "request to join" flow (D-020)
    this.orgsTable.addGlobalSecondaryIndex({
      indexName: 'by-email-domain',
      partitionKey: { name: 'emailDomain', type: dynamodb.AttributeType.STRING },
    });

    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'heediq-users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });
    // Org membership queries (admin seat management, D-017)
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'by-org',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    });
    // Email-as-identity lookup for cross-provider account linking (D-078) — email is
    // lowercased/trimmed by the writer before every put, never by the table itself.
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'by-email',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
    });

    // Auth methods-per-account + audit trail for cross-provider linking (D-087, replicating
    // EmotiXOrg/emotix-infra's schema). PK = `USER#<accountId>`; SK differs by table:
    // `METHOD#<PROVIDER>` (one row per linked sign-in method) vs `EVENT#<isoTimestamp>` (append-only).
    this.userAuthMethodsTable = new dynamodb.Table(this, 'UserAuthMethodsTable', {
      tableName: 'heediq-user-auth-methods',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    this.authAuditLogTable = new dynamodb.Table(this, 'AuthAuditLogTable', {
      tableName: 'heediq-auth-audit-log',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // PK = sourceId — one active job per source at MVP; DDB Streams feeds StatusPusher (D-061)
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: 'heediq-jobs',
      partitionKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy,
    });

    // PK = connectionId; GSI by-source for fan-out; TTL cleans up stale rows (D-061)
    this.wsConnectionsTable = new dynamodb.Table(this, 'WsConnectionsTable', {
      tableName: 'heediq-ws-connections',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
    });
    this.wsConnectionsTable.addGlobalSecondaryIndex({
      indexName: 'by-source',
      partitionKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── SQS — transcription queue (D-023) ────────────────────────────────────

    const transcriptionDlq = new sqs.Queue(this, 'TranscriptionDlq', {
      queueName: 'heediq-transcription-dlq',
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.transcriptionQueue = new sqs.Queue(this, 'TranscriptionQueue', {
      queueName: 'heediq-transcription',
      // Covers longest expected paid-tier job (large-v3 + pyannote on CPU, 60-min source)
      visibilityTimeout: cdk.Duration.seconds(3600),
      deadLetterQueue: { queue: transcriptionDlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });

    // ── S3 — audio uploads (D-023) ────────────────────────────────────────────
    // Account-ID suffix keeps name globally unique while preserving D-037 spirit
    // (see infra README Gotchas — S3 global namespace)

    this.audioUploadsBucket = new s3.Bucket(this, 'AudioUploadsBucket', {
      bucketName: `heediq-audio-uploads-${cdk.Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [
            'https://heediq.com',
            'https://staging.heediq.com',
            'https://dev.heediq.com',
            'http://localhost:5173',
          ],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          // Paid-tier archival safety net (D-022); free-tier 30-day deletion handled by app
          id: 'archive-to-glacier-deep',
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
        {
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      removalPolicy,
      autoDeleteObjects: !isProd,
    });

    // All OBJECT_CREATED events → SQS; Fargate worker filters by file extension
    this.audioUploadsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.transcriptionQueue),
    );

    // ── S3 — web assets (CloudFront origin; WebStack OAC) ───────────────────

    this.webAssetsBucket = new s3.Bucket(this, 'WebAssetsBucket', {
      bucketName: `heediq-web-assets-${cdk.Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !isProd,
    });

    // Grant CloudFront OAC read access. Source-account condition avoids a circular CDK
    // dependency: WebStack can't add bucket policy from outside this stack without
    // exporting the distribution ARN back here (Foundation → WebStack ← Foundation).
    // One distribution per workload account makes the source-account scope acceptable.
    this.webAssetsBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudFrontOAC',
      actions: ['s3:GetObject'],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      resources: [this.webAssetsBucket.arnForObjects('*')],
      conditions: {
        StringEquals: { 'AWS:SourceAccount': this.account },
      },
    }));

    // ── Auth provisioning Lambda trigger (D-077) ──────────────────────────────
    // Fires on every token issuance (native email/password AND federated Google/Microsoft —
    // PreTokenGeneration is the only trigger guaranteed to fire for both). Idempotent
    // get-or-create of Org+User in DynamoDB, then injects custom:orgId/custom:role claims.
    // Real code deployed by heediq-api CI (same pattern as ApiStack.apiFn) — placeholder here.
    const authProvisionFn = new lambda.Function(this, 'AuthProvisionFn', {
      functionName: 'heediq-auth-provision',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'auth-provision.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async (event) => event;',
      ),
      memorySize: COMPUTE.lambda.authProvision.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.authProvision.timeoutSecs),
      environment: {
        ORGS_TABLE_NAME: this.orgsTable.tableName,
        USERS_TABLE_NAME: this.usersTable.tableName,
      },
    });
    this.orgsTable.grantReadWriteData(authProvisionFn);
    this.usersTable.grantReadWriteData(authProvisionFn);

    // ── SES — heediq.com identity for Cognito's own OTP/confirmation emails (D-095) ──
    // Cognito's custom-SES email config requires the identity in the SAME account as the
    // User Pool — cross-account SES (the D-058 pattern used for app-initiated Lambda email)
    // is not supported by Cognito itself. This identity exists solely so Cognito can send its
    // native SignUp/ConfirmSignUp codes (D-087) via real SES instead of its default mailer.
    // ON FIRST DEPLOY for each new environment, the 3 DKIM CNAMEs (below, in stack outputs)
    // must be manually added to Route 53 in the shared-services account — same one-time,
    // per-environment manual step as the ACM wildcard cert above (D-063).
    const sesIdentity = new ses.CfnEmailIdentity(this, 'CognitoSesEmailIdentity', {
      emailIdentity: DOMAINS.root,
      dkimAttributes: { signingEnabled: true },
    });

    for (let i = 1; i <= 3; i++) {
      const name = (sesIdentity as unknown as Record<string, string>)[`attrDkimDnsTokenName${i}`];
      const value = (sesIdentity as unknown as Record<string, string>)[`attrDkimDnsTokenValue${i}`];
      new cdk.CfnOutput(this, `CognitoSesDkimCname${i}`, {
        value: `${name} CNAME ${value}`,
        description: `DKIM CNAME ${i}/3 for the Cognito SES identity — add to shared-services Route 53 on first deploy`,
      });
    }

    // ── Cognito User Pool (D-020) ─────────────────────────────────────────────

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'heediq-users',
      signInAliases: { email: true },
      autoVerify: { email: true },
      selfSignUpEnabled: true,
      email: cognito.UserPoolEmail.withSES({
        fromEmail: `noreply@${DOMAINS.root}`,
        fromName: 'Heediq',
        sesVerifiedDomain: DOMAINS.root,
      }),
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // custom:orgId / custom:role are set only by AuthProvisionFn (D-077), never by the
      // user or client directly — mutable so the trigger can update them post-creation.
      customAttributes: {
        orgId: new cognito.StringAttribute({ mutable: true }),
        role: new cognito.StringAttribute({ mutable: true }),
      },
      lambdaTriggers: {
        preTokenGeneration: authProvisionFn,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });
    this.userPool.node.addDependency(sesIdentity);

    // Hosted domain for OAuth redirects. Custom auth.heediq.com deferred (extra cert + DNS).
    const userPoolDomain = this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: { domainPrefix: `heediq-${props.workloadEnv}` },
    });

    // ── Cross-provider account-linking triggers (D-087) ───────────────────────
    // Replicates EmotiXOrg/emotix-infra's proven pattern: explicit Lambda triggers (not
    // Cognito's built-in attribute-based auto-link) so linking gets a DynamoDB audit trail
    // and a canonical-account-id resolution step (needed for `/auth/methods` to show one
    // consistent method list regardless of which session — native or federated — is active).
    // Declared after `this.userPool` purely for readability (grouped with the pool below);
    // IAM below is scoped by account/region pattern, not the pool's own ARN token — see
    // the comment above `userPoolArnPattern` for why a direct ARN reference isn't possible.
    // Real code deployed by heediq-api CI (same pattern as AuthProvisionFn above).
    const authTriggerPreSignUpFn = new lambda.Function(this, 'AuthTriggerPreSignUpFn', {
      functionName: 'heediq-auth-trigger-pre-signup',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'auth-trigger-pre-signup.handler',
      code: lambda.Code.fromInline('exports.handler = async (event) => event;'),
      memorySize: COMPUTE.lambda.authTrigger.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.authTrigger.timeoutSecs),
      environment: {
        USERS_TABLE_NAME: this.usersTable.tableName,
        USER_AUTH_METHODS_TABLE_NAME: this.userAuthMethodsTable.tableName,
      },
    });

    const authTriggerPostConfirmationFn = new lambda.Function(this, 'AuthTriggerPostConfirmationFn', {
      functionName: 'heediq-auth-trigger-post-confirmation',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'auth-trigger-post-confirmation.handler',
      code: lambda.Code.fromInline('exports.handler = async (event) => event;'),
      memorySize: COMPUTE.lambda.authTrigger.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.authTrigger.timeoutSecs),
      environment: {
        USERS_TABLE_NAME: this.usersTable.tableName,
        USER_AUTH_METHODS_TABLE_NAME: this.userAuthMethodsTable.tableName,
        AUTH_AUDIT_LOG_TABLE_NAME: this.authAuditLogTable.tableName,
      },
    });

    const authTriggerPostAuthenticationFn = new lambda.Function(this, 'AuthTriggerPostAuthenticationFn', {
      functionName: 'heediq-auth-trigger-post-authentication',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'auth-trigger-post-authentication.handler',
      code: lambda.Code.fromInline('exports.handler = async (event) => event;'),
      memorySize: COMPUTE.lambda.authTrigger.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.authTrigger.timeoutSecs),
      environment: {
        USERS_TABLE_NAME: this.usersTable.tableName,
        USER_AUTH_METHODS_TABLE_NAME: this.userAuthMethodsTable.tableName,
        AUTH_AUDIT_LOG_TABLE_NAME: this.authAuditLogTable.tableName,
      },
    });

    for (const fn of [authTriggerPreSignUpFn, authTriggerPostConfirmationFn, authTriggerPostAuthenticationFn]) {
      this.usersTable.grantReadData(fn);
      this.userAuthMethodsTable.grantReadWriteData(fn);
    }
    this.authAuditLogTable.grantWriteData(authTriggerPostConfirmationFn);
    this.authAuditLogTable.grantWriteData(authTriggerPostAuthenticationFn);

    // pre-signup needs to create/query Cognito users directly (auto-heal + link-lookup);
    // post-authentication needs the same plus AdminLinkProviderForUser. Can't scope to
    // `this.userPool.userPoolArn` directly: that token creates a CFN dependency back onto
    // the pool resource, which already depends on these functions via addTrigger below —
    // a circular reference CloudFormation rejects. Scoping to account/region instead (one
    // pool per account per D-037, so this is still account/region-scoped, not a bare `*`).
    const userPoolArnPattern = cdk.Stack.of(this).formatArn({
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

    // Wired via addTrigger (not the lambdaTriggers prop above) since these functions are
    // declared after pool construction.
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, authTriggerPreSignUpFn);
    this.userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, authTriggerPostConfirmationFn);
    this.userPool.addTrigger(cognito.UserPoolOperation.POST_AUTHENTICATION, authTriggerPostAuthenticationFn);

    // Federated IdP credentials live in Secrets Manager — set real values after registering
    // OAuth apps with Google Cloud Console and Azure portal (D-020). Pool deploys with
    // placeholder values; email/password auth works immediately.

    const googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleIdP', {
      userPool: this.userPool,
      clientId: ssm.StringParameter.valueForStringParameter(this, '/heediq/auth/google-client-id'),
      clientSecretValue: cdk.SecretValue.secretsManager('/heediq/auth/google-client-secret'),
      scopes: ['email', 'profile', 'openid'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        givenName: cognito.ProviderAttribute.GOOGLE_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
      },
    });

    // Full issuer URL in SSM: https://login.microsoftonline.com/{tenant-id}/v2.0
    const microsoftProvider = new cognito.UserPoolIdentityProviderOidc(this, 'MicrosoftIdP', {
      userPool: this.userPool,
      name: 'Microsoft',
      clientId: ssm.StringParameter.valueForStringParameter(this, '/heediq/auth/microsoft-client-id'),
      clientSecret: cdk.SecretValue.secretsManager('/heediq/auth/microsoft-client-secret').unsafeUnwrap(),
      issuerUrl: ssm.StringParameter.valueForStringParameter(this, '/heediq/auth/microsoft-issuer-url'),
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: cognito.ProviderAttribute.other('email'),
        givenName: cognito.ProviderAttribute.other('name'),
      },
    });

    const webDomain = DOMAINS.web[props.workloadEnv];

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'heediq-web',
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE, cognito.OAuthScope.OPENID],
        callbackUrls: [
          `https://${webDomain}/auth/callback`,
          `https://${webDomain}/settings/link-callback`,
          ...(props.workloadEnv === 'dev'
            ? ['http://localhost:5173/auth/callback', 'http://localhost:5173/settings/link-callback']
            : []),
        ],
        logoutUrls: [
          `https://${webDomain}`,
          ...(props.workloadEnv === 'dev' ? ['http://localhost:5173'] : []),
        ],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.GOOGLE,
        cognito.UserPoolClientIdentityProvider.custom('Microsoft'),
      ],
    });

    // Ensure IdP constructs are created before the client references them
    this.userPoolClient.node.addDependency(googleProvider);
    this.userPoolClient.node.addDependency(microsoftProvider);

    // ── SSM params — resource locators for all app repos (D-038) ─────────────

    const ssmParams: Array<[string, string, string]> = [
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
    ];

    for (const [name, value, description] of ssmParams) {
      new ssm.StringParameter(this, name.replace(/\//g, '-').slice(1), {
        parameterName: name,
        stringValue: value,
        description,
      });
    }
  }
}
