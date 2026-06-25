// @ts-check
'use strict';

const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
} = require('@aws-sdk/client-route-53');

// Node.js 22 Lambda runtime includes @aws-sdk v3 — no bundling needed.

/**
 * CDK custom resource handler — manages a Route 53 A-alias record in the
 * shared-services hosted zone from a workload account.
 *
 * ResourceProperties:
 *   RecordName        — FQDN to create/manage, e.g. 'ws-dev.heediq.com'
 *   TargetDnsName     — alias target DNS name (API GW regional domain, CloudFront, etc.)
 *   TargetHostedZoneId — Route 53 zone ID of the alias target (differs by AWS service/region)
 *   HostedZoneId      — heediq.com hosted zone ID in shared-services
 *   RoleArn           — heediq-route53-dns-manager ARN (D-064)
 */
exports.handler = async (event) => {
  const { RequestType, ResourceProperties } = event;
  const { RecordName, TargetDnsName, TargetHostedZoneId, HostedZoneId, RoleArn } =
    ResourceProperties;

  const physicalId = HostedZoneId + ':' + RecordName + ':A';
  const r53 = await assumeRole(RoleArn);

  if (RequestType === 'Delete') {
    await upsertOrDelete(r53, HostedZoneId, RecordName, TargetDnsName, TargetHostedZoneId, 'DELETE')
      .catch((err) => {
        if (err.name === 'InvalidChangeBatch') return; // record already gone — no-op
        throw err;
      });
    return { PhysicalResourceId: physicalId };
  }

  await upsertOrDelete(r53, HostedZoneId, RecordName, TargetDnsName, TargetHostedZoneId, 'UPSERT');
  return { PhysicalResourceId: physicalId };
};

async function assumeRole(roleArn) {
  const sts = new STSClient({});
  const { Credentials } = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'cdk-route53-alias',
      DurationSeconds: 900,
    }),
  );
  return new Route53Client({
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
    },
  });
}

async function upsertOrDelete(r53, hostedZoneId, recordName, targetDnsName, targetHostedZoneId, action) {
  const { ChangeInfo } = await r53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: action,
            ResourceRecordSet: {
              Name: recordName,
              Type: 'A',
              AliasTarget: {
                DNSName: targetDnsName,
                HostedZoneId: targetHostedZoneId,
                EvaluateTargetHealth: false,
              },
            },
          },
        ],
      },
    }),
  );

  // Poll until INSYNC — typically < 30s, hard cap at 2 minutes
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const { ChangeInfo: updated } = await r53.send(new GetChangeCommand({ Id: ChangeInfo.Id }));
    if (updated.Status === 'INSYNC') return;
  }

  throw new Error('Route 53 change ' + ChangeInfo.Id + ' did not reach INSYNC within 2 minutes');
}
