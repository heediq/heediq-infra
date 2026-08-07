// Transcription dispatcher Lambda (D-157).
//
// Single consumer of the `heediq-transcription` SQS queue. Reads the job's `tier` from the
// message body and calls ECS RunTask on the matching per-tier task definition (free / paid),
// on the EC2 GPU Spot capacity provider. This replaces the two EventBridge Pipes that used to
// poll one queue with complementary `tier` message-attribute filters — a design where the
// wrong-tier Pipe silently deleted ~50% of jobs (Pipes drops filter-rejected messages with no
// error, no DLQ). Routing now lives in code: one queue, one consumer, content-based branch.
//
// The worker container has no SQS client of its own — the raw message body is handed to it via
// the `SQS_MESSAGE_BODY` container override (one RunTask = one job, D-066).
//
// Failures return the message id in `batchItemFailures` so SQS retries and, after
// maxReceiveCount, routes to `heediq-transcription-dlq` (partial-batch-response contract; the
// event source is configured with reportBatchItemFailures).
//
// Pure routing logic lives in ./routing.mjs so it can be unit-tested without the runtime SDK.

import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { buildRunTaskInput, safeParse } from './routing.mjs';

const ecs = new ECSClient({});

export async function handler(event) {
  const batchItemFailures = [];

  for (const record of event.Records ?? []) {
    try {
      const res = await ecs.send(new RunTaskCommand(buildRunTaskInput(record.body, process.env)));
      const taskArn = res.tasks?.[0]?.taskArn;
      if (!taskArn) {
        // RunTask accepted the call but placed no task (e.g. no capacity yet) — surface for retry.
        throw new Error(`RunTask placed no task: ${JSON.stringify(res.failures ?? [])}`);
      }
      const { jobId, tier } = safeParse(record.body);
      console.log(JSON.stringify({ level: 'info', msg: 'runtask.launched', jobId, tier, taskArn }));
    } catch (err) {
      // No PII in logs (D-038/D-093) — message body is not logged, only ids + error string.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'dispatch.failed',
          messageId: record.messageId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
