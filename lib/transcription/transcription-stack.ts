import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import { Construct } from 'constructs';
import { WorkloadEnv, COMPUTE, ACCOUNTS, AWS_REGION } from '../config';
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
    // Structured logs only — no PII (transcript text, audio URLs) per D-038
    const logGroup = new logs.LogGroup(this, 'TranscriptionLogGroup', {
      logGroupName: '/heediq/transcription',
      retention: logs.RetentionDays.ONE_MONTH,
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
    foundation.recordingsTable.grantWriteData(taskRole);

    // ── Task definitions (D-059, D-060, D-062) ────────────────────────────────
    // EC2 task definitions with gpuCount=1 per container. ECS GPU resource tracking ensures
    // at most one task runs per g4dn.xlarge instance (1 GPU per instance).
    // Same ECR image for both tiers; TIER env var tells the worker which model to load (D-060).
    // Models are baked into the image at build time — no runtime download (D-062).
    const ecrImageUri = `${ACCOUNTS.sharedServices}.dkr.ecr.${AWS_REGION}.amazonaws.com/heediq-worker-transcription`;

    // Config injected as env vars at launch — no SSM in hot path (D-038)
    const baseEnv: Record<string, string> = {
      AWS_DEFAULT_REGION: AWS_REGION,
      JOBS_TABLE_NAME: foundation.jobsTable.tableName,
      RECORDINGS_TABLE_NAME: foundation.recordingsTable.tableName,
      AUDIO_BUCKET_NAME: foundation.audioUploadsBucket.bucketName,
    };

    // Free tier: whisper small — 1 vCPU / 2 GB / 1 GPU (D-059, D-062)
    const freeTierTaskDef = new ecs.Ec2TaskDefinition(this, 'FreeTierTaskDef', {
      networkMode: ecs.NetworkMode.BRIDGE,
      executionRole,
      taskRole,
    });
    freeTierTaskDef.addContainer('Worker', {
      containerName: 'heediq-transcription-worker',
      image: ecs.ContainerImage.fromRegistry(ecrImageUri),
      environment: { ...baseEnv, TIER: 'free' },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'free', logGroup }),
      gpuCount: 1,
      cpu: COMPUTE.gpu.free.cpu,
      memoryLimitMiB: COMPUTE.gpu.free.memoryMiB,
    });

    // Paid tier: whisper large-v3 + pyannote diarization — 4 vCPU / 8 GB / 1 GPU (D-059, D-062)
    const paidTierTaskDef = new ecs.Ec2TaskDefinition(this, 'PaidTierTaskDef', {
      networkMode: ecs.NetworkMode.BRIDGE,
      executionRole,
      taskRole,
    });
    paidTierTaskDef.addContainer('Worker', {
      containerName: 'heediq-transcription-worker',
      image: ecs.ContainerImage.fromRegistry(ecrImageUri),
      environment: { ...baseEnv, TIER: 'paid' },
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

    // ── IAM: EventBridge Pipes role ────────────────────────────────────────────
    const pipeRole = new iam.Role(this, 'PipeRole', {
      roleName: 'heediq-transcription-pipe',
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });

    // SQS: receive + delete + get-attributes (pipe manages message lifecycle)
    foundation.transcriptionQueue.grantConsumeMessages(pipeRole);

    pipeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [freeTierTaskDef.taskDefinitionArn, paidTierTaskDef.taskDefinitionArn],
      }),
    );

    // PassRole so the RunTask call can attach both roles to the ECS task
    pipeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [executionRole.roleArn, taskRole.roleArn],
      }),
    );

    // ── EventBridge Pipes (D-023, D-059) — SQS → ECS RunTask on EC2 GPU Spot ──
    // Two pipes, one per tier, each filtered on the 'tier' SQS message attribute.
    // The API sets messageAttributes.tier = 'free' | 'paid' when enqueuing a job.
    // No launchType field — capacityProviderStrategy takes precedence (AWS requirement).
    // No networkConfiguration — bridge-mode EC2 tasks share the host network; awsvpcConfiguration
    // only applies to awsvpc-mode tasks.
    const tierPipes: Array<['free' | 'paid', ecs.Ec2TaskDefinition]> = [
      ['free', freeTierTaskDef],
      ['paid', paidTierTaskDef],
    ];

    for (const [tier, taskDef] of tierPipes) {
      const capitalized = (tier.charAt(0).toUpperCase() + tier.slice(1)) as 'Free' | 'Paid';

      new pipes.CfnPipe(this, `${capitalized}TierPipe`, {
        name: `heediq-transcription-${tier}`,
        roleArn: pipeRole.roleArn,
        source: foundation.transcriptionQueue.queueArn,
        sourceParameters: {
          sqsQueueParameters: { batchSize: 1 },
          filterCriteria: {
            filters: [
              {
                pattern: JSON.stringify({
                  messageAttributes: { tier: { stringValue: [tier] } },
                }),
              },
            ],
          },
        },
        target: cluster.clusterArn,
        targetParameters: {
          ecsTaskParameters: {
            taskDefinitionArn: taskDef.taskDefinitionArn,
            capacityProviderStrategy: [
              { capacityProvider: capacityProvider.capacityProviderName, weight: 1 },
            ],
          },
        },
      });
    }
  }
}
