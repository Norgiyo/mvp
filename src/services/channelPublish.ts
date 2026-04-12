import { acquireCooldown, getCooldownTtl, withRedisLock } from "./antiAbuse";

const CHANNEL_PUBLISH_LOCK_SECONDS = 20;
const CHANNEL_PUBLISH_COOLDOWN_SECONDS = 5;

export type ChannelPublishResult<T> =
  | { status: "ok"; value: T }
  | { status: "busy" }
  | { status: "duplicate"; retryAfterSeconds: number };

export async function runSerializedChannelPublish<T>(
  action: string,
  work: () => Promise<T>,
  options: {
    lockSeconds?: number;
    cooldownSeconds?: number;
  } = {}
): Promise<ChannelPublishResult<T>> {
  const lockSeconds = options.lockSeconds ?? CHANNEL_PUBLISH_LOCK_SECONDS;
  const cooldownSeconds = options.cooldownSeconds ?? CHANNEL_PUBLISH_COOLDOWN_SECONDS;

  const result = await withRedisLock("channel:publish", lockSeconds, async () => {
    const retryAfterSeconds = await getCooldownTtl("channel_publish", action);
    if (retryAfterSeconds > 0) {
      return {
        status: "duplicate" as const,
        retryAfterSeconds
      };
    }

    const value = await work();
    await acquireCooldown("channel_publish", action, cooldownSeconds);

    return {
      status: "ok" as const,
      value
    };
  });

  return result ?? { status: "busy" };
}
