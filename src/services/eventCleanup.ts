import type { Api } from "grammy";

import { env } from "../config";
import { redis } from "../db/redis";
import { sql } from "../db/postgres";
import { withRedisLock } from "./antiAbuse";
import { tickAuction } from "./auction";
import { cleanupExpiredMining } from "./mining";
import { closeRaffleAndAnnounce } from "./raffles";

import type {
  AdEventState,
  BirthdayEventState,
  LuckyDropState
} from "../types";

function isExpired(isoDate: string): boolean {
  return new Date(isoDate).getTime() <= Date.now();
}

type TimedMessageState = {
  messageId: number;
  expiresAt: string;
};

type RaffleEventState = {
  messageId: number;
  expiresAt: string;
};

function dayExpiryIso(day: string): string {
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
  return new Date(dayStart + 24 * 60 * 60 * 1000).toISOString();
}

async function saveTimedGroupMessage(
  keyPrefix: string,
  activeSetKey: string,
  id: string,
  messageId: number,
  expiresAt: string
): Promise<void> {
  const state: TimedMessageState = { messageId, expiresAt };
  await redis.set(`${keyPrefix}:${id}`, state, { ex: 60 * 60 * 72 });
  await redis.sadd(activeSetKey, id);
}

export async function registerDailyRewardMessage(day: string, messageId: number): Promise<void> {
  await saveTimedGroupMessage("daily:event", "daily:active", day, messageId, dayExpiryIso(day));
}

export async function registerTemporaryGroupMessage(
  keyPrefix: string,
  activeSetKey: string,
  id: string,
  messageId: number,
  expiresAt: string
): Promise<void> {
  await saveTimedGroupMessage(keyPrefix, activeSetKey, id, messageId, expiresAt);
}

async function cleanupTimedMessages(
  api: Api,
  activeSetKey: string,
  keyPrefix: string
): Promise<void> {
  const ids = await redis.smembers<string[]>(activeSetKey);

  for (const id of ids ?? []) {
    const key = `${keyPrefix}:${id}`;
    const state = await redis.get<TimedMessageState>(key);

    if (!state) {
      await redis.srem(activeSetKey, id);
      continue;
    }

    if (!isExpired(state.expiresAt)) {
      continue;
    }

    await api.deleteMessage(env.groupChatId, state.messageId).catch(() => undefined);
    await redis.del(key);
    await redis.srem(activeSetKey, id);
  }
}

async function cleanupExpiredDrops(api: Api): Promise<void> {
  const activeIds = await redis.smembers<string[]>("drops:active");

  for (const dropId of activeIds ?? []) {
    const state = await redis.get<LuckyDropState>(`drop:event:${dropId}`);
    if (!state) {
      await redis.srem("drops:active", dropId);
      continue;
    }

    if (!isExpired(state.expiresAt)) {
      continue;
    }

    await api.deleteMessage(env.groupChatId, state.messageId).catch(() => undefined);
    await redis.del(`drop:event:${dropId}`);
    await redis.srem("drops:active", dropId);
  }
}

async function cleanupExpiredBirthdays(api: Api): Promise<void> {
  const activeIds = await redis.smembers<string[]>("birthdays:active");

  for (const eventId of activeIds ?? []) {
    const key = `birthday:event:${eventId}`;
    const state = await redis.get<BirthdayEventState>(key);
    if (!state) {
      await redis.srem("birthdays:active", eventId);
      continue;
    }

    if (!isExpired(state.expiresAt)) {
      continue;
    }

    await api.deleteMessage(env.groupChatId, state.messageId).catch(() => undefined);
    await redis.del(key);
    await redis.srem("birthdays:active", eventId);
  }
}

async function cleanupExpiredAds(api: Api): Promise<void> {
  const activeIds = await redis.smembers<string[]>("ads:active");

  for (const eventId of activeIds ?? []) {
    const state = await redis.get<AdEventState>(`ad:event:${eventId}`);
    if (!state) {
      await redis.srem("ads:active", eventId);
      continue;
    }

    if (!isExpired(state.expiresAt)) {
      continue;
    }

    await api.deleteMessage(env.groupChatId, state.messageId).catch(() => undefined);
    await redis.del(`ad:event:${eventId}`);
    await redis.srem("ads:active", eventId);
  }
}

async function cleanupExpiredOrClosedRaffles(api: Api): Promise<void> {
  const expiredActiveRaffles = await sql<{ id: string }[]>`
    select id
    from raffles
    where status = 'active'
      and ends_at <= now()
    order by ends_at asc
  `;

  for (const raffle of expiredActiveRaffles) {
    await closeRaffleAndAnnounce(api, raffle.id);
  }

  const activeIds = await redis.smembers<string[]>("raffles:active");

  for (const raffleId of activeIds ?? []) {
    const key = `raffle:event:${raffleId}`;
    const state = await redis.get<RaffleEventState>(key);
    if (!state) {
      await redis.srem("raffles:active", raffleId);
      continue;
    }

    if (isExpired(state.expiresAt)) {
      await api.deleteMessage(env.groupChatId, state.messageId).catch(() => undefined);
      await redis.del(key);
      await redis.srem("raffles:active", raffleId);
      continue;
    }

    const rows = await sql<{ status: string }[]>`
      select status
      from raffles
      where id = ${raffleId}
      limit 1
    `;
    const raffle = rows[0];
    if (!raffle || raffle.status !== "active") {
      await api.deleteMessage(env.groupChatId, state.messageId).catch(() => undefined);
      await redis.del(key);
      await redis.srem("raffles:active", raffleId);
    }
  }
}

export async function cleanupExpiredEventMessages(api: Api): Promise<void> {
  const throttleKey = "cleanup:throttle";
  const acquired = await redis.set(throttleKey, "1", { nx: true, ex: 60 });
  if (acquired !== "OK") {
    return;
  }

  await withRedisLock("cleanup:expired_events", 10, async () => {
    await cleanupTimedMessages(api, "daily:active", "daily:event");
    await cleanupTimedMessages(api, "drop:winner:active", "drop:winner");
    await cleanupTimedMessages(api, "boosts:active", "boost:msg");
    await cleanupExpiredAds(api);
    await cleanupExpiredDrops(api);
    await cleanupExpiredBirthdays(api);
    await tickAuction(api);
    await cleanupExpiredMining(api);
    await cleanupExpiredOrClosedRaffles(api);
    return true;
  });
}
