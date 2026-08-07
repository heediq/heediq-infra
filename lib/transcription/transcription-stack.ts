import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { Construct } from 'constructs';
import { WorkloadEnv, COMPUTE, ACCOUNTS, AWS_REGION, logRetentionFor } from '../config';
import { FoundationStack } from '../foundation/foundation-stack';

export interface TranscriptionStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
  foundation: FoundationStack;
}

export class TranscriptionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TranscriptionStackProps) {
    super(scope, id, props);
    const { foundation } = props;

    // ── CloudWatch log group ──────────────────────────────────────────────────
    // Structured logs only — no PII (transcript text, audio URLs) per D-038.
    // Explicit per-env retention (D-093): 30 days dev/staging, 90 days prod.
    const logGroup = new logs.LogGroup(this, 'TranscriptionLogGroup', {
      logGroupName: '/heediq/transcription',
      retention: logRetentionFor(props.workloadEnv),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── VPC — public subnets only, no NAT gateway ─────────────────────────────
    // EC2 instances use public IPs to reach ECR + S3 + DynamoDB.
    // NAT gateway (~$32/AZ/mo) is unjustifiable at MVP; public subnets cost nothing fixed.
    // Hardcode eu-west-1 AZs to avoid a context lookup — synth must work without AWS credentials
    // in the CI validate job (D-043). Change this if the primary region changes (D-044).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: 'heediq-transcription',
      availabilityZones: [`${AWS_REGION}a`, `${AWS_REGION}b`],
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Outbound-only: instances pull audio from S3, write to DynamoDB, pull image from ECR
    const instanceSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      securityGroupName: 'heediq-transcription-task',
      description: 'EC2 GPU transcription instance - outbound only',
      allowAllOutbound: true,
    });

    // ── ECS Cluster (D-037 naming) ─────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'heediq-transcription',
      vpc,
    });

    // ── IAM: EC2 instance role ─────────────────────────────────────────────────
    // Allows the ECS agent on the instance to: register with the cluster, pull images from ECR,
    // write logs to CloudWatch, and report instance/container health.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      roleName: 'heediq-transcription-instance',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
      ],
    });

    // ── IAM: execution role (ECS agent — pull image from ECR, write logs) ─────
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'heediq-transcription-execution',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // GetAuthorizationToken is a global action — cannot be scoped to a specific repo
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // Cross-account ECR pull from shared-services (D-045, D-059, D-062).
    // The ECR repo also has AllowWorkloadAccountPull resource policy (SharedServicesStack) —
    // both sides of the cross-account trust are required.
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: [
          `arn:aws:ecr:${AWS_REGION}:${ACCOUNTS.sharedServices}:repository/heediq-worker-transcription`,
        ],
      }),
    );

    // ── IAM: task role (app code — read S3, write DynamoDB) ───────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'heediq-transcription-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    foundation.audioUploadsBucket.grantRead(taskRole);
    foundation.jobsTable.grantWriteData(taskRole);
    foundation.sourcesTable.grantWriteData(taskRole);

    // SQS — enqueue to summarization queue when transcription completes (D-065)
    // ARN constructed from known constants — no CDK cross-stack dependency needed.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [
          `arn:aws:sqs:${AWS_REGION}:${ACCOUNTS[props.workloadEnv]}:heediq-summarization`,
        ],
      }),
    );

    // SQS — re-enqueue to the transcription queue on Spot interruption (D-066). The dispatcher
    // Lambda (not the worker) consumes heediq-transcription and the message is deleted as soon as
    // the job is handed to RunTask, so the worker must explicitly re-send on SIGTERM instead of
    // relying on visibility-timeout expiry.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [foundation.transcriptionQueue.queueArn],
      }),
    );

    // ── Task definitions (D-059, D-060, D-062) ────────────────────────────────
    // EC2 task definitions with gpuCount=1 per container. ECS GPU resource tracking ensures
    // at most one task runs per g4dn.xlarge instance (1 GPU per instance).
    // Two separate images, one per tier — each has only its tier's model baked in at build
    // time (D-062). `family` is explicit so CI can target task-definition revisions by name
    // when promoting a new image (describe → patch image → register). The dispatcher Lambda
    // runs tasks by family (D-157), so it always picks up the latest ACTIVE revision — no
    // infra redeploy on image promotion.
    const ecrRepoUri = `${ACCOUNTS.sharedServices}.dkr.ecr.${AWS_REGION}.amazonaws.com/heediq-worker-transcription`;

    // Per-environment, per-tier image tag — externally owned by CI (deploy.yml), NOT by CDK.
    // Resolved via a CloudFormation dynamic reference (`{{resolve:ssm:...}}`) at deploy time, so
    // synth still works without AWS credentials (D-043) — same pattern as the GPU AMI lookup below.
    // CI seeds each parameter once per environment (initial value 'free'/'paid' matching the
    // mutable bootstrap tag) and overwrites it with an immutable `sha-<7chars>` tag on every
    // promotion (D-047). Because CDK only *reads* this parameter, an unrelated `cdk deploy` can
    // never roll a promoted image back to the bootstrap tag.
    const freeImageTagParam = ssm.StringParameter.fromStringParameterName(
      this,
      'FreeImageTagParam',
      '/heediq/transcription/free-image-tag',
    );
    const paidImageTagParam = ssm.StringParameter.fromStringParameterName(
      this,
      'PaidImageTagParam',
      '/heediq/transcription/paid-image-tag',
    );

    // Config injected as env vars at launch — no SSM in hot path (D-038)
    const baseEnv: Record<string, string> = {
      AWS_DEFAULT_REGION: AWS_REGION,
      JOBS_TABLE_NAME: foundation.jobsTable.tableName,
      SOURCES_TABLE_NAME: foundation.sourcesTable.tableName,
      AUDIO_BUCKET_NAME: foundation.audioUploadsBucket.bucketName,
      TRANSCRIPTION_QUEUE_URL: foundation.transcriptionQueue.queueUrl,
      // Summarization queue URL — enqueue after transcription completes (D-065)
      SUMMARIZATION_QUEUE_URL: `https://sqs.${AWS_REGION}.amazonaws.com/${ACCOUNTS[props.workloadEnv]}/heediq-summarization`,
    };

    // Free tier: whisper small — 1 vCPU / 2 GB / 1 GPU (D-059, D-062)
    const freeTierTaskDef = new ecs.Ec2TaskDefinition(this, 'FreeTierTaskDef', {
      family: 'heediq-transcription-free',
      networkMode: ecs.NetworkMode.BRIDGE,
      executionRole,
      taskRole,
    });
    freeTierTaskDef.addContainer('Worker', {
      containerName: 'heediq-transcription-worker',
      image: ecs.ContainerImage.fromRegistry(`${ecrRepoUri}:${freeImageTagParam.stringValue}`),
      environment: baseEnv,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'free', logGroup }),
      gpuCount: 1,
      cpu: COMPUTE.gpu.free.cpu,
      memoryLimitMiB: COMPUTE.gpu.free.memoryMiB,
    });

    // Paid tier: whisper large-v3 + pyannote diarization — 4 vCPU / 8 GB / 1 GPU (D-059, D-062)
    const paidTierTaskDef = new ecs.Ec2TaskDefinition(this, 'PaidTierTaskDef', {
      family: 'heediq-transcription-paid',
      networkMode: ecs.NetworkMode.BRIDGE,
      executionRole,
      taskRole,
    });
    paidTierTaskDef.addContainer('Worker', {
      containerName: 'heediq-transcription-worker',
      image: ecs.ContainerImage.fromRegistry(`${ecrRepoUri}:${paidImageTagParam.stringValue}`),
      environment: baseEnv,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'paid', logGroup }),
      gpuCount: 1,
      cpu: COMPUTE.gpu.paid.cpu,
      memoryLimitMiB: COMPUTE.gpu.paid.memoryMiB,
    });

    // ── EC2 Launch Template ───────────────────────────────────────────────────
    // ECS-optimized GPU AMI: Docker + ECS agent + nvidia-container-toolkit pre-installed.
    // AMI resolved from SSM at CloudFormation deploy time — no CDK context lookup so synth
    // works without AWS credentials in the CI validate job (D-043).
    const userData = ec2.UserData.forLinux();
    userData.addCommands(`echo ECS_CLUSTER=${cluster.clusterName} >> /etc/ecs/ecs.config`);

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: 'heediq-transcription-gpu',
      instanceType: new ec2.InstanceType(COMPUTE.gpu.instanceType),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id',
        { os: ec2.OperatingSystemType.LINUX },
      ),
      role: instanceRole,
      securityGroup: instanceSg,
      userData,
    });

    // ── Auto Scaling Group ────────────────────────────────────────────────────
    // min=0: zero idle cost when the SQS queue is empty (D-059).
    // 100% Spot via mixed instances policy, CAPACITY_OPTIMIZED allocation: AWS picks the
    // g4dn.xlarge Spot pool with the most available capacity, minimising interruption frequency.
    // max=10 is a safety ceiling; ECS managed scaling controls the actual desired count.
    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      autoScalingGroupName: 'heediq-transcription-asg',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minCapacity: 0,
      maxCapacity: 10,
      mixedInstancesPolicy: {
        launchTemplate,
        launchTemplateOverrides: [
          { instanceType: new ec2.InstanceType(COMPUTE.gpu.instanceType) },
        ],
        instancesDistribution: {
          onDemandBaseCapacity: 0,
          onDemandPercentageAboveBaseCapacity: 0,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
        },
      },
    });

    // ── ECS capacity provider ─────────────────────────────────────────────────
    // managedScaling at target=100%: ECS scales the ASG to exactly the number of instances
    // needed to run all pending tasks, then back to 0 when the queue drains.
    // managedTerminationProtection: ECS drains tasks before the ASG terminates an instance
    // on scale-in — prevents mid-job Spot interruption from ASG itself (worker still handles
    // the AWS-initiated SIGTERM from Spot reclamation separately, D-059).
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'CapacityProvider', {
      autoScalingGroup: asg,
      capacityProviderName: 'heediq-transcription-ec2',
      enableManagedScaling: true,
      targetCapacityPercent: 100,
      enableManagedTerminationProtection: true,
    });
    cluster.addAsgCapacityProvider(capacityProvider);

    // ── Dispatcher Lambda (D-157) — SQS → ECS RunTask on EC2 GPU Spot ──────────
    // Single consumer of heediq-transcription. Reads `tier` from the message body and runs the
    // matching task-definition family, on the GPU Spot capacity provider. Replaces the two
    // EventBridge Pipes that competed on one queue with complementary `tier` filters — a design
    // where the losing Pipe silently deleted the message (Pipes drops filter-rejected messages
    // with no error and no DLQ). Routing now lives in code: one queue, one consumer, one DLQ.
    const dispatcherLogGroup = new logs.LogGroup(this, 'DispatcherLogGroup', {
      logGroupName: '/aws/lambda/heediq-transcription-dispatcher',
      retention: logRetentionFor(props.workloadEnv),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dispatcher = new lambda.Function(this, 'Dispatcher', {
      functionName: 'heediq-transcription-dispatcher',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'dispatcher'), {
        exclude: ['README.md'],
      }),
      memorySize: COMPUTE.lambda.transcriptionDispatcher.memoryMB,
      timeout: cdk.Duration.seconds(COMPUTE.lambda.transcriptionDispatcher.timeoutSecs),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: dispatcherLogGroup,
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        CAPACITY_PROVIDER: capacityProvider.capacityProviderName,
        CONTAINER_NAME: 'heediq-transcription-worker',
        FREE_TASK_DEF_FAMILY: freeTierTaskDef.family,
        PAID_TASK_DEF_FAMILY: paidTierTaskDef.family,
      },
    });

    // SQS trigger — batchSize 1 (one RunTask per job) with partial-batch responses so a failed
    // dispatch retries via the queue and, after maxReceiveCount, lands in heediq-transcription-dlq
    // (the event source also grants the Lambda ReceiveMessage/DeleteMessage/GetQueueAttributes).
    dispatcher.addEventSource(
      new lambdaEventSources.SqsEventSource(foundation.transcriptionQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // ecs:RunTask scoped to both families (`:*` = any revision — the Lambda runs by family so it
    // resolves the latest ACTIVE revision at call time).
    dispatcher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [
          `arn:aws:ecs:${AWS_REGION}:${ACCOUNTS[props.workloadEnv]}:task-definition/heediq-transcription-free:*`,
          `arn:aws:ecs:${AWS_REGION}:${ACCOUNTS[props.workloadEnv]}:task-definition/heediq-transcription-paid:*`,
        ],
      }),
    );

    // PassRole so the RunTask call can attach both roles to the ECS task.
    dispatcher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [executionRole.roleArn, taskRole.roleArn],
      }),
    );

    new ssm.StringParameter(this, 'DispatcherFunctionNameParam', {
      parameterName: '/heediq/transcription/dispatcher-function-name',
      stringValue: dispatcher.functionName,
    });
  }
}
