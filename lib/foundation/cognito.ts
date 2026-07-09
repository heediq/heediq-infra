import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { WorkloadEnv, DOMAINS } from '../config';

export interface FoundationCognito {
  userPool: cognito.UserPool;
  userPoolDomain: cognito.UserPoolDomain;
  userPoolClient: cognito.UserPoolClient;
}

export interface FoundationCognitoProps {
  workloadEnv: WorkloadEnv;
  removalPolicy: cdk.RemovalPolicy;
  authProvisionFn: lambda.Function;
  sesIdentity: ses.CfnEmailIdentity;
}

// ── Cognito User Pool (D-020) — pool, hosted domain, federated IdPs, app client ──
export function createCognitoUserPool(scope: Construct, props: FoundationCognitoProps): FoundationCognito {
  const { workloadEnv, removalPolicy, authProvisionFn, sesIdentity } = props;

  const userPool = new cognito.UserPool(scope, 'UserPool', {
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
    // custom:orgId / custom:role / custom:accountId are set only by AuthProvisionFn
    // (D-077, D-099), never by the user or client directly — mutable so the trigger can
    // update them post-creation. custom:accountId is the stable, app-owned identity
    // anchor (D-099): decoupled from Cognito's `sub`, which can be repointed by
    // AdminLinkProviderForUser during account linking. custom:permissions (D-102, Phase 3)
    // is a JSON-stringified array of the user's resolved effective Permission strings, baked
    // in at token issuance — default 2048-char max comfortably covers the current 8-entry
    // catalog. custom:rbacVersion is compared per-request against the live counter on
    // heediq-users to force re-login the moment a user's roles/permissions change.
    customAttributes: {
      orgId: new cognito.StringAttribute({ mutable: true }),
      role: new cognito.StringAttribute({ mutable: true }),
      accountId: new cognito.StringAttribute({ mutable: true }),
      permissions: new cognito.StringAttribute({ mutable: true }),
      rbacVersion: new cognito.NumberAttribute({ mutable: true }),
    },
    lambdaTriggers: {
      preTokenGeneration: authProvisionFn,
    },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    removalPolicy,
  });
  userPool.node.addDependency(sesIdentity);

  // Hosted domain for OAuth redirects. Custom auth.heediq.com deferred (extra cert + DNS).
  const userPoolDomain = userPool.addDomain('UserPoolDomain', {
    cognitoDomain: { domainPrefix: `heediq-${workloadEnv}` },
  });

  // Federated IdP credentials live in Secrets Manager — set real values after registering
  // OAuth apps with Google Cloud Console and Azure portal (D-020). Pool deploys with
  // placeholder values; email/password auth works immediately.

  const googleProvider = new cognito.UserPoolIdentityProviderGoogle(scope, 'GoogleIdP', {
    userPool,
    clientId: ssm.StringParameter.valueForStringParameter(scope, '/heediq/auth/google-client-id'),
    clientSecretValue: cdk.SecretValue.secretsManager('/heediq/auth/google-client-secret'),
    scopes: ['email', 'profile', 'openid'],
    attributeMapping: {
      email: cognito.ProviderAttribute.GOOGLE_EMAIL,
      givenName: cognito.ProviderAttribute.GOOGLE_NAME,
      profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
    },
  });

  // Full issuer URL in SSM: https://login.microsoftonline.com/{tenant-id}/v2.0
  const microsoftProvider = new cognito.UserPoolIdentityProviderOidc(scope, 'MicrosoftIdP', {
    userPool,
    name: 'Microsoft',
    clientId: ssm.StringParameter.valueForStringParameter(scope, '/heediq/auth/microsoft-client-id'),
    clientSecret: cdk.SecretValue.secretsManager('/heediq/auth/microsoft-client-secret').unsafeUnwrap(),
    issuerUrl: ssm.StringParameter.valueForStringParameter(scope, '/heediq/auth/microsoft-issuer-url'),
    scopes: ['openid', 'email', 'profile'],
    attributeMapping: {
      email: cognito.ProviderAttribute.other('email'),
      givenName: cognito.ProviderAttribute.other('name'),
    },
  });

  const webDomain = DOMAINS.web[workloadEnv];

  const userPoolClient = new cognito.UserPoolClient(scope, 'UserPoolClient', {
    userPool,
    userPoolClientName: 'heediq-web',
    generateSecret: false,
    authFlows: { userPassword: true, userSrp: true },
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE, cognito.OAuthScope.OPENID],
      callbackUrls: [
        `https://${webDomain}/auth/callback`,
        `https://${webDomain}/settings/link-callback`,
        ...(workloadEnv === 'dev'
          ? ['http://localhost:5173/auth/callback', 'http://localhost:5173/settings/link-callback']
          : []),
      ],
      logoutUrls: [
        `https://${webDomain}`,
        ...(workloadEnv === 'dev' ? ['http://localhost:5173'] : []),
      ],
    },
    supportedIdentityProviders: [
      cognito.UserPoolClientIdentityProvider.COGNITO,
      cognito.UserPoolClientIdentityProvider.GOOGLE,
      cognito.UserPoolClientIdentityProvider.custom('Microsoft'),
    ],
  });

  // Ensure IdP constructs are created before the client references them
  userPoolClient.node.addDependency(googleProvider);
  userPoolClient.node.addDependency(microsoftProvider);

  return { userPool, userPoolDomain, userPoolClient };
}
