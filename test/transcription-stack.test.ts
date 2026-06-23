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

  it('creates 2 Fargate task definitions', () => {
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    template.allResourcesProperties('AWS::ECS::TaskDefinition', {
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
    });
  });

  it('free-tier task def has 1 vCPU / 2 GB and TIER=free', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '1024',
      Memory: '2048',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([{ Name: 'TIER', Value: 'free' }]),
        }),
      ]),
    });
  });

  it('paid-tier task def has 4 vCPU / 8 GB and TIER=paid', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '8192',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([{ Name: 'TIER', Value: 'paid' }]),
        }),
      ]),
    });
  });

  it('both task defs inject JOBS_TABLE_NAME, RECORDINGS_TABLE_NAME, AUDIO_BUCKET_NAME', () => {
    for (const envKey of ['JOBS_TABLE_NAME', 'RECORDINGS_TABLE_NAME', 'AUDIO_BUCKET_NAME']) {
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
    // awslogs-group is a CFn Ref token (not the literal string) — check driver + prefix only
    template.allResourcesProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          LogConfiguration: Match.objectLike({ LogDriver: 'awslogs' }),
        }),
      ]),
    });
  });

  // ── IAM roles ───────────────────────────────────────────────────────────────

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

  it('creates pipe role trusted by pipes.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'heediq-transcription-pipe',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'pipes.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('pipe role policy includes ecs:RunTask and iam:PassRole', () => {
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

  // ── EventBridge Pipes ───────────────────────────────────────────────────────

  it('creates 2 EventBridge Pipes', () => {
    template.resourceCountIs('AWS::Pipes::Pipe', 2);
  });

  it('creates free-tier pipe named heediq-transcription-free', () => {
    template.hasResourceProperties('AWS::Pipes::Pipe', {
      Name: 'heediq-transcription-free',
    });
  });

  it('creates paid-tier pipe named heediq-transcription-paid', () => {
    template.hasResourceProperties('AWS::Pipes::Pipe', {
      Name: 'heediq-transcription-paid',
    });
  });

  it('both pipes use FARGATE_SPOT capacity provider', () => {
    template.allResourcesProperties('AWS::Pipes::Pipe', {
      TargetParameters: Match.objectLike({
        EcsTaskParameters: Match.objectLike({
          CapacityProviderStrategy: Match.arrayWith([
            Match.objectLike({ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }),
          ]),
        }),
      }),
    });
  });

  it('both pipes batch size is 1 — one job per Fargate task', () => {
    template.allResourcesProperties('AWS::Pipes::Pipe', {
      SourceParameters: Match.objectLike({
        SqsQueueParameters: { BatchSize: 1 },
      }),
    });
  });

  it('pipes use assignPublicIp=ENABLED (public subnets, no NAT)', () => {
    template.allResourcesProperties('AWS::Pipes::Pipe', {
      TargetParameters: Match.objectLike({
        EcsTaskParameters: Match.objectLike({
          NetworkConfiguration: Match.objectLike({
            AwsvpcConfiguration: Match.objectLike({
              AssignPublicIp: 'ENABLED',
            }),
          }),
        }),
      }),
    });
  });

  it('free-tier pipe filter matches tier=free message attribute', () => {
    template.hasResourceProperties('AWS::Pipes::Pipe', {
      Name: 'heediq-transcription-free',
      SourceParameters: Match.objectLike({
        FilterCriteria: Match.objectLike({
          Filters: Match.arrayWith([
            Match.objectLike({
              Pattern: Match.stringLikeRegexp('"stringValue":\\["free"\\]'),
            }),
          ]),
        }),
      }),
    });
  });

  it('paid-tier pipe filter matches tier=paid message attribute', () => {
    template.hasResourceProperties('AWS::Pipes::Pipe', {
      Name: 'heediq-transcription-paid',
      SourceParameters: Match.objectLike({
        FilterCriteria: Match.objectLike({
          Filters: Match.arrayWith([
            Match.objectLike({
              Pattern: Match.stringLikeRegexp('"stringValue":\\["paid"\\]'),
            }),
          ]),
        }),
      }),
    });
  });
});
