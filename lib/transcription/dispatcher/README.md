# Transcription dispatcher Lambda (D-157)

Infra-owned Lambda that is the **sole consumer** of the `heediq-transcription` SQS queue. It reads
`tier` from the job message **body** and calls `ecs:RunTask` on the matching per-tier task-def
**family**, handing the raw message body to the worker container via the `SQS_MESSAGE_BODY`
override, on the EC2 GPU Spot capacity provider.

Replaces the two EventBridge Pipes that polled one queue with complementary `tier` message-attribute
filters — a design where the losing Pipe silently deleted the message (Pipes drops filter-rejected
messages with no error and no DLQ, so ~50% of jobs vanished). Routing is now content-based in code:
one queue, one consumer, one real DLQ.

## Files
- `index.mjs` — Lambda entrypoint (`handler`). Owns the `@aws-sdk/client-ecs` call (SDK is
  runtime-provided) and partial-batch-response bookkeeping.
- `routing.mjs` — pure, SDK-free logic (`taskDefForTier`, `buildRunTaskInput`, `safeParse`), so it
  is unit-testable without the runtime SDK. Tested in `test/transcription-dispatcher.test.ts`.

## Contract
- **Input**: SQS records whose body is a `TranscriptionJobMessage` (`@heediq/shared`) — `tier` is
  read from the body, not a message attribute.
- **Env** (set by `transcription-stack.ts`): `CLUSTER_ARN`, `CAPACITY_PROVIDER`, `CONTAINER_NAME`,
  `FREE_TASK_DEF_FAMILY`, `PAID_TASK_DEF_FAMILY`.
- **Failure**: any error (bad/unknown tier, RunTask placed no task) returns the message id in
  `batchItemFailures` → SQS retries → `heediq-transcription-dlq` after `maxReceiveCount` (3).
- Task defs are run by **family**, so CI image promotions (new revision) are picked up with no infra
  redeploy.

Wiring, IAM, and the queue's visibility-timeout sizing live in
[`../transcription-stack.ts`](../transcription-stack.ts); see the repo `README.md`
§"TranscriptionStack resources".
