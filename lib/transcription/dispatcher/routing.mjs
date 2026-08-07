// Pure routing logic for the transcription dispatcher (D-157). No AWS SDK import so it can be
// unit-tested without the runtime-provided @aws-sdk/client-ecs dependency. index.mjs (the Lambda
// entrypoint) imports these and wires them to the real ECS client.

// Map a job tier to its task-definition family. Task defs are referenced by FAMILY (not a pinned
// revision) so RunTask always launches the latest ACTIVE revision — CI promotes new images by
// registering a new revision, no infra redeploy needed.
export function taskDefForTier(tier, families) {
  if (tier === 'free') return families.free;
  if (tier === 'paid') return families.paid;
  throw new Error(`unknown tier: ${JSON.stringify(tier)}`);
}

// Build the ECS RunTask input for a raw SQS message body.
export function buildRunTaskInput(body, env) {
  const { tier } = JSON.parse(body);
  return {
    cluster: env.CLUSTER_ARN,
    taskDefinition: taskDefForTier(tier, {
      free: env.FREE_TASK_DEF_FAMILY,
      paid: env.PAID_TASK_DEF_FAMILY,
    }),
    // No launchType — capacityProviderStrategy takes precedence (AWS requirement). No
    // networkConfiguration — bridge-mode EC2 tasks share the host network.
    capacityProviderStrategy: [{ capacityProvider: env.CAPACITY_PROVIDER, weight: 1 }],
    count: 1,
    overrides: {
      containerOverrides: [
        {
          name: env.CONTAINER_NAME,
          environment: [{ name: 'SQS_MESSAGE_BODY', value: body }],
        },
      ],
    },
  };
}

export function safeParse(body) {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}
