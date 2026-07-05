import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { WorkloadEnv } from '../config';

export interface ObservabilityStackProps extends cdk.StackProps {
  workloadEnv: WorkloadEnv;
}

// D-085: native AWS observability (CloudWatch + X-Ray, no Grafana/separate tool). This stack
// only *reads* other stacks' well-known resource names (D-037: no env prefix, so names are
// static constants) rather than taking construct props — avoids coupling the dashboard's
// lifecycle to every other stack's synth order.
export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const lambdaMetric = (functionName: string, metricName: string, stat = 'Sum') =>
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName,
        dimensionsMap: { FunctionName: functionName },
        statistic: stat,
        period: cdk.Duration.minutes(5),
      });

    const sqsMetric = (queueName: string, metricName: string, stat = 'Maximum') =>
      new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName,
        dimensionsMap: { QueueName: queueName },
        statistic: stat,
        period: cdk.Duration.minutes(5),
      });

    const asgMetric = (asgName: string, metricName: string, stat = 'Average') =>
      new cloudwatch.Metric({
        namespace: 'AWS/AutoScaling',
        metricName,
        dimensionsMap: { AutoScalingGroupName: asgName },
        statistic: stat,
        period: cdk.Duration.minutes(5),
      });

    const ecsClusterMetric = (clusterName: string, metricName: string, stat = 'Average') =>
      new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName,
        dimensionsMap: { ClusterName: clusterName },
        statistic: stat,
        period: cdk.Duration.minutes(5),
      });

    // ── API Lambda ─────────────────────────────────────────────────────────────
    const apiErrorsWidget = new cloudwatch.GraphWidget({
      title: 'API Lambda — Errors & Invocations',
      left: [lambdaMetric('heediq-api', 'Invocations'), lambdaMetric('heediq-api', 'Errors')],
      width: 12,
    });
    const apiDurationWidget = new cloudwatch.GraphWidget({
      title: 'API Lambda — Duration (p50/p99)',
      left: [
        lambdaMetric('heediq-api', 'Duration', 'p50'),
        lambdaMetric('heediq-api', 'Duration', 'p99'),
      ],
      width: 12,
    });

    // ── Summarization Lambda ──────────────────────────────────────────────────
    const summarizationErrorsWidget = new cloudwatch.GraphWidget({
      title: 'Summarization Lambda — Errors & Invocations',
      left: [
        lambdaMetric('heediq-summarization', 'Invocations'),
        lambdaMetric('heediq-summarization', 'Errors'),
      ],
      width: 12,
    });
    const summarizationDurationWidget = new cloudwatch.GraphWidget({
      title: 'Summarization Lambda — Duration (p50/p99)',
      left: [
        lambdaMetric('heediq-summarization', 'Duration', 'p50'),
        lambdaMetric('heediq-summarization', 'Duration', 'p99'),
      ],
      width: 12,
    });

    // ── SQS queue depth & DLQ counts ───────────────────────────────────────────
    const queueDepthWidget = new cloudwatch.GraphWidget({
      title: 'SQS — Queue Depth (in-flight + visible)',
      left: [
        sqsMetric('heediq-transcription', 'ApproximateNumberOfMessagesVisible'),
        sqsMetric('heediq-summarization', 'ApproximateNumberOfMessagesVisible'),
      ],
      width: 12,
    });
    const dlqWidget = new cloudwatch.GraphWidget({
      title: 'SQS — DLQ Message Counts',
      left: [
        sqsMetric('heediq-transcription-dlq', 'ApproximateNumberOfMessagesVisible'),
        sqsMetric('heediq-summarization-dlq', 'ApproximateNumberOfMessagesVisible'),
      ],
      width: 12,
    });

    // ── ECS GPU Spot fleet health (D-059) ─────────────────────────────────────
    const ecsHealthWidget = new cloudwatch.GraphWidget({
      title: 'Transcription GPU Fleet — In-Service Instances & CPU Reservation',
      left: [asgMetric('heediq-transcription-asg', 'GroupInServiceInstances')],
      right: [ecsClusterMetric('heediq-transcription', 'CPUReservation')],
      width: 12,
    });

    // ── Job stage funnel (Logs Insights on the transcription worker log group) ─
    // Structured logs from src/logger.py (D-085) — status field is never PII (D-038).
    const jobFunnelWidget = new cloudwatch.LogQueryWidget({
      title: 'Transcription Job Stage Funnel (last query window)',
      logGroupNames: ['/heediq/transcription'],
      view: cloudwatch.LogQueryVisualizationType.TABLE,
      queryLines: [
        "filter message = 'Job status changed'",
        'stats count(*) as jobs by status',
      ],
      width: 24,
    });

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `heediq-${props.workloadEnv}`,
      widgets: [
        [apiErrorsWidget, apiDurationWidget],
        [summarizationErrorsWidget, summarizationDurationWidget],
        [queueDepthWidget, dlqWidget],
        [ecsHealthWidget],
        [jobFunnelWidget],
      ],
    });
  }
}
