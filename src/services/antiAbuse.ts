import { appConfig } from "../config";
import { redis } from "../db/redis";
import { sql } from "../db/postgres";

type FraudDetails = Record<string, unknown>;

export async function markUpdateSeen(updateId: number): Promise<boolean> {
  const key = `tg:update:${updateId}`;
  const result = await redis.set(key, "1", { nx: true, ex: 60 * 60 * 24 });
  return result === "OK";
}

export async function checkCallbackRateLimit(userId: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (appConfig.callbackWindowSeconds * 1000));
  const key = `ratelimit:callback:${userId}:${bucket}`;
  const total = await redis.incr(key);

  if (total === 1) {
    await redis.expire(key, appConfig.callbackWindowSeconds);
  }

  return total <= appConfig.callbackBurstLimit;
}

export async function acquireCooldown(
  action: string,
  subject: string | number,
  seconds: number
): Promise<boolean> {
  const key = `cooldown:${action}:${subject}`;
  const result = await redis.set(key, "1", { nx: true, ex: seconds });
  return result === "OK";
}

export async function getCooldownTtl(action: string, subject: string | number): Promise<number> {
  const key = `cooldown:${action}:${subject}`;
  const ttl = await redis.ttl(key);
  return typeof ttl === "number" && ttl > 0 ? ttl : 0;
}

export async function withRedisLock<T>(
  key: string,
  seconds: number,
  work: () => Promise<T>
): Promise<T | null> {
  const lockKey = `lock:${key}`;
  const acquired = await redis.set(lockKey, "1", { nx: true, ex: seconds });
  if (acquired !== "OK") {
    return null;
  }

  try {
    return await work();
  } finally {
    await redis.del(lockKey);
  }
}

export async function logFraud(
  action: string,
  details: FraudDetails,
  userId?: number | null
): Promise<void> {
  try {
    await sql`
      insert into fraud_logs (user_id, action, details)
      values (${userId ?? null}, ${action}, ${JSON.stringify(details)}::jsonb)
    `;
  } catch {
    // Best effort only: anti-abuse logging should never block the main flow.
  }
}
