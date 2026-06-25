import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface Route53AliasRecordProps {
  /** Fully-qualified domain name to create/manage, e.g. 'ws-dev.heediq.com' */
  recordName: string;
  /** DNS name of the alias target (API Gateway regional domain, CloudFront, etc.) */
  targetDnsName: string;
  /** Route 53 hosted zone ID of the alias target (differs by AWS service and region) */
  targetHostedZoneId: string;
  /** Route 53 hosted zone ID that owns the record (the heediq.com zone in shared-services) */
  hostedZoneId: string;
  /** ARN of heediq-route53-dns-manager role in shared-services account (D-064) */
  dnsManagerRoleArn: string;
}

/**
 * Creates a Route 53 A-alias record in the shared-services hosted zone from a workload account.
 *
 * CDK cannot natively manage Route 53 records in a different account. This construct uses a
 * Lambda-backed custom resource that assumes heediq-route53-dns-manager (D-064) to make
 * cross-account Route 53 API calls. On stack delete, the record is removed automatically.
 *
 * Handler: lib/shared/handlers/route53-alias-record/index.js
 * Reusable across WebSocketStack, ApiStack, and WebStack.
 */
export class Route53AliasRecord extends Construct {
  constructor(scope: Construct, id: string, props: Route53AliasRecordProps) {
    super(scope, id);

    const handlerRole = new iam.Role(this, 'HandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [props.dnsManagerRoleArn],
      }),
    );

    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, 'handlers/route53-alias-record'),
      ),
      timeout: cdk.Duration.minutes(5),
      role: handlerRole,
    });

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: handler,
    });

    new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        RecordName: props.recordName,
        TargetDnsName: props.targetDnsName,
        TargetHostedZoneId: props.targetHostedZoneId,
        HostedZoneId: props.hostedZoneId,
        RoleArn: props.dnsManagerRoleArn,
      },
    });
  }
}
