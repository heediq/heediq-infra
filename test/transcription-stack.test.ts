import { describe, it, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation/foundation-stack';
import { TranscriptionStack } from '../lib/transcription/transcription-stack';

describe('TranscriptionStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const foundation = new FoundationStack(app, 'TestFoundationStack', {
      env: { account: '276594885933', region: 'eu-west-1' },
      workloadEnv: 'dev',
    });
    const stack = new TranscriptionStack(app, 'TestTranscriptionStack', {
      env: { account: '276594885933', region: 'eu-west-1' },
      workloadEnv: 'dev',
      foundation,
    });
    template = Template.fromStack(stack);
  });

  // ── VPC ────────────────────────────────────────────────────────────────────

  it('creates a VPC named heediq-transcription', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      Tags: Match.arrayWith([{ Key: 'Name', Value: 'heediq-transcription' }]),
    });
  });

  it('creates only public subnets — no private subnets (no NAT cost)', () => {
    // 2 AZs × 1 public subnet each = 2 public subnets total
    template.resourceCountIs('AWS::EC2::Subnet', 2);
    template.allResourcesProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
    });
  });

  it('creates no NAT gateways', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  // ── CloudWatch Log Group ────────────────────────────────────────────────────

  it('creates CloudWatch log group /heediq/transcription', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/heediq/transcription',
      RetentionInDays: 30,
    });
  });

  // ── ECS Cluster ─────────────────────────────────────────────────────────────

  it('creates ECS cluster named heediq-transcription', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'heediq-transcription',
    });
  });

  // ── Task definitions ────────────────────────────────────────────────────────

  it('creates 2 EC2 task definitions with bridge networking', () => {
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    template.allResourcesProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['EC2'],
      NetworkMode: 'bridge',
    });
  });

  it('free-tier task def has family heediq-transcription-free, 1 vCPU / 2 GB / 1 GPU, and an image tag resolved from the free-image-tag SSM parameter', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'heediq-transcription-free',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Cpu: 1024,
          Memory: 2048,
          Image: {
            'Fn::Join': [
              '',
              [
                Match.stringLikeRegexp('heediq-worker-transcription:$'),
                Match.objectLike({ Ref: Match.stringLikeRegexp('^FreeImageTagParam') }),
              ],
            ],
          },
          ResourceRequirements: Match.arrayWith([
            Match.objectLike({ Type: 'GPU', Value: '1' }),
          ]),
        }),
      ]),
    });
  });

  it('paid-tier task def has family heediq-transcription-paid, 4 vCPU / 8 GB / 1 GPU, and an image tag resolved from the paid-image-tag SSM parameter', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'heediq-transcription-paid',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Cpu: 4096,
          Memory: 8192,
          Image: {
            'Fn::Join': [
              '',
              [
                Match.stringLikeRegexp('heediq-worker-transcription:$'),
                Match.objectLike({ Ref: Match.stringLikeRegexp('^PaidImageTagParam') }),
              ],
            ],
          },
          ResourceRequirements: Match.arrayWith([
            Match.objectLike({ Type: 'GPU', Value: '1' }),
          ]),
        }),
      ]),
    });
  });

  it('neither task def sets a TIER env var — tier routing is per-image (D-062), not env-based', () => {
    template.allResourcesProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.not(Match.arrayWith([Match.objectLike({ Name: 'TIER' })])),
        }),
      ]),
    });
  });

  it('both task defs inject JOBS_TABLE_NAME, SOURCES_TABLE_NAME, AUDIO_BUCKET_NAME', () => {
    for (const envKey of ['JOBS_TABLE_NAME', 'SOURCES_TABLE_NAME', 'AUDIO_BUCKET_NAME']) {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([Match.objectLike({ Name: envKey })]),
          }),
        ]),
      });
    }
  });

  it('both task defs use awslogs log driver pointing at the transcription log group', () => {
    template.allResourcesProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          LogConfiguration: Match.objectLike({ LogDriver: 'awslogs' }),
        }),
      ]),
    });
  });

  // ── EC2 Launch Template ─────────────────────────────────────────────────────

  it('creates EC2 Launch Template named heediq-transcription-gpu with g4dn.xlarge', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'heediq-transcription-gpu',
      LaunchTemplateData: Match.objectLike({
        InstanceType: 'g4dn.xlarge',
      }),
    });
  });

  it('launch template uses ECS-optimized GPU AMI resolved from SSM at deploy time', () => {
    // CDK materialises fromSsmParameter() as a CloudFormation Parameter of type
    // AWS::SSM::Parameter::Value<AWS::EC2::Image::Id> — resolved at deploy, not synth.
    // This is what preserves the "synth without AWS credentials" requirement (D-043).
    template.hasParameter('*', {
      Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
      Default: '/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id',
    });
  });

  // ── Auto Scaling Group ──────────────────────────────────────────────────────

  it('creates ASG named heediq-transcription-asg with min=0 and max=10', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'heediq-transcription-asg',
      MinSize: '0',
      MaxSize: '10',
    });
  });

  it('ASG uses 100% Spot with capacity-optimized allocation strategy', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MixedInstancesPolicy: Match.objectLike({
        InstancesDistribution: Match.objectLike({
          OnDemandPercentageAboveBaseCapacity: 0,
          SpotAllocationStrategy: 'capacity-optimized',
        }),
      }),
    });
  });

  // ── ECS Capacity Provider ───────────────────────────────────────────────────

  it('creates EC2 capacity provider named heediq-transcription-ec2', () => {
    template.hasResourceProperties('AWS::ECS::CapacityProvider', {
      Name: 'heediq-transcription-ec2',
      AutoScalingGroupProvider: Match.objectLike({
        ManagedScaling: Match.objectLike({
          Status: 'ENABLED',
          TargetCapacity: 100,
        }),
        ManagedTerminationProtection: 'ENABLED',
      }),
    });
  });

  it('attaches capacity provider to the ECS cluster', () => {
    // One ClusterCapacityProviderAssociations resource confirms the provider is wired up.
    // CapacityProvider entry is a CDK Ref token — the name is verified by the capacity
    // provider test above.
    template.resourceCountIs('AWS::ECS::ClusterCapacityProviderAssociations', 1);
  });

  // ── IAM roles ───────────────────────────────────────────────────────────────

  it('creates instance role trusted by ec2.amazonaws.com with AmazonEC2ContainerServiceforEC2Role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'heediq-transcription-instance',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ec2.amazonaws.com' },
          }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('AmazonEC2ContainerServiceforEC2Role'),
            ]),
          ]),
        }),
      ]),
    });
  });

  it('creates execution role trusted by ecs-tasks.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'heediq-transcription-execution',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('execution role policy grants cross-account ECR pull from shared-services', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ecr:GetDownloadUrlForLayer',
              'ecr:BatchGetImage',
              'ecr:BatchCheckLayerAvailability',
            ]),
            Resource: Match.stringLikeRegexp('313828097088.*heediq-worker-transcription'),
          }),
        ]),
      }),
    });
  });

  it('creates task role trusted by ecs-tasks.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'heediq-transcription-task',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('dispatcher Lambda role policy includes ecs:RunTask and iam:PassRole (D-157)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'ecs:RunTask' }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'iam:PassRole' }),
        ]),
      }),
    });
  });

  it('task role policy grants sqs:SendMessage on heediq-summarization queue (D-065)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sqs:SendMessage',
            Resource: Match.stringLikeRegexp('heediq-summarization'),
          }),
        ]),
      }),
    });
  });

  it('task role policy grants sqs:SendMessage on the transcription queue itself — Spot-interruption re-enqueue (D-066)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sqs:SendMessage',
            Resource: Match.objectLike({
              'Fn::ImportValue': Match.stringLikeRegexp('TranscriptionQueue'),
            }),
          }),
        ]),
      }),
    });
  });

  // ── Dispatcher Lambda (D-157) ────────────────────────────────────────────────

  it('retires EventBridge Pipes entirely — no Pipe resources remain', () => {
    template.resourceCountIs('AWS::Pipes::Pipe', 0);
  });

  it('creates the dispatcher Lambda on the Node 22 runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-transcription-dispatcher',
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    });
  });

  it('dispatcher Lambda gets the cluster, capacity provider, container name, and both task-def families as env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'heediq-transcription-dispatcher',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          CONTAINER_NAME: 'heediq-transcription-worker',
          FREE_TASK_DEF_FAMILY: 'heediq-transcription-free',
          PAID_TASK_DEF_FAMILY: 'heediq-transcription-paid',
          // CAPACITY_PROVIDER resolves to a Ref token at synth (deploy-time name); the separate
          // capacity-provider test confirms it renders as heediq-transcription-ec2.
          CAPACITY_PROVIDER: Match.anyValue(),
        }),
      }),
    });
  });

  it('dispatcher Lambda is triggered by the transcription queue with partial-batch reporting', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      EventSourceArn: Match.objectLike({
        'Fn::ImportValue': Match.stringLikeRegexp('TranscriptionQueue'),
      }),
    });
  });

  it('dispatcher ecs:RunTask is scoped to both task-def families by name, any revision (:*)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ecs:RunTask',
            Resource: Match.arrayWith([
              Match.stringLikeRegexp('task-definition/heediq-transcription-free:\\*'),
              Match.stringLikeRegexp('task-definition/heediq-transcription-paid:\\*'),
            ]),
          }),
        ]),
      }),
    });
  });

  it('publishes the dispatcher function name to SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/heediq/transcription/dispatcher-function-name',
    });
  });
});
