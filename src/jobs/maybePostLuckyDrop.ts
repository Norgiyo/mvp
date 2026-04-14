import crypto from "node:crypto";

import type { Api } from "grammy";

import { appConfig, env } from "../config";
import { redis } from "../db/redis";
import { cleanupExpiredEventMessages } from "../services/eventCleanup";
import type { LuckyDropState } from "../types";
import { encodeCallback } from "../utils/callbackData";
import { addSeconds } from "../utils/time";

const LUCKY_DROP_MIN_COINS = 0;
const LUCKY_DROP_MAX_COINS = 10;

export async function maybePostLuckyDrop(
  api: Api,
  options: { force?: boolean } = {}
): Promise<{ posted: boolean }> {
  await cleanupExpiredEventMessages(api);

  if (!options.force) {
    const recent = await redis.ttl("drop:last_posted");
    if (typeof recent === "number" && recent > 0) {
      return { posted: false };
    }
  }

  const dropId = crypto.randomUUID();
  const expiresAt = addSeconds(new Date(), appConfig.dropTtlSeconds);
  const reward = crypto.randomInt(LUCKY_DROP_MIN_COINS, LUCKY_DROP_MAX_COINS + 1);

  const message = await api.sendMessage(
    env.groupChatId,
    "Lucky drop\n\nNadie sabe cuanto trae. El primero que lo abra descubre lo que salio.",
    {
      disable_notification: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "ABRIR",
              callback_data: encodeCallback("drop", dropId),
              style: "success"
            }
          ]
        ]
      }
    }
  );

  const state: LuckyDropState = {
    id: dropId,
    reward,
    messageId: message.message_id,
    expiresAt: expiresAt.toISOString()
  };

  await redis.set(`drop:event:${dropId}`, state, { ex: appConfig.dropTtlSeconds });
  await redis.sadd("drops:active", dropId);
  await redis.set("drop:last_posted", dropId, { ex: env.luckyDropEventCooldownSeconds });

  return { posted: true };
}
