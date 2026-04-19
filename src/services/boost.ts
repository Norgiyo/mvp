import { redis } from "../db/redis";
import { withRedisLock } from "./antiAbuse";
import type { BoostEventState } from "../types";
import { addSeconds, isExpired } from "../utils/time";

const BOOST_TTL_SECONDS = 60 * 60 * 24;
const BOOST_MAX_SLOTS = 100;

export async function createBoostEvent(messageId: number): Promise<BoostEventState> {
  const id = crypto.randomUUID();
  const expiresAt = addSeconds(new Date(), BOOST_TTL_SECONDS).toISOString();
  const state: BoostEventState = { id, messageId, expiresAt, maxSlots: BOOST_MAX_SLOTS };
  await redis.set(`boost:event:${id}`, state, { ex: BOOST_TTL_SECONDS });
  await redis.sadd("boosts:active", id);
  return state;
}

export async function getBoostEvent(boostId: string): Promise<BoostEventState | null> {
  const state = await redis.get<BoostEventState>(`boost:event:${boostId}`);
  if (!state || isExpired(state.expiresAt)) return null;
  return state;
}

export async function claimBoost(boostId: string, userId: number): Promise<
  | { status: "ok"; claimedCount: number }
  | { status: "expired" | "full" | "duplicate" }
> {
  const event = await getBoostEvent(boostId);
  if (!event) return { status: "expired" };

  const lockResult = await withRedisLock(`boost:claim:lock:${boostId}`, 5, async () => {
    const alreadyClaimed = await redis.sismember(`boost:claimed:${boostId}`, String(userId));
    if (alreadyClaimed) return { status: "duplicate" as const };

    const count = await redis.scard(`boost:claimed:${boostId}`);
    if (count >= event.maxSlots) return { status: "full" as const };

    await redis.sadd(`boost:claimed:${boostId}`, String(userId));
    await redis.set(`boost:user:${userId}`, boostId, { ex: BOOST_TTL_SECONDS });

    return { status: "ok" as const, claimedCount: count + 1 };
  });

  return lockResult ?? { status: "expired" as const };
}

export async function hasActiveBoost(userId: number): Promise<boolean> {
  const result = await redis.get(`boost:user:${userId}`);
  return result !== null;
}
