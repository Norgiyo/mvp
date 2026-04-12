import crypto from "node:crypto";

import type { Api } from "grammy";

import { appConfig, env } from "../config";
import { redis } from "../db/redis";
import { cleanupExpiredEventMessages } from "../services/eventCleanup";
import type { LuckyDropState } from "../types";
import { encodeCallback } from "../utils/callbackData";
import { addSeconds } from "../utils/time";

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

  const message = await api.sendMessage(
    env.groupChatId,
    `🎁 Lucky drop\n\nEl primero que llegue se lleva +${env.luckyDropRewardCoins} 🪙`,
    {
      disable_notification: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎁 Agarrarlo",
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
    reward: env.luckyDropRewardCoins,
    messageId: message.message_id,
    expiresAt: expiresAt.toISOString()
  };

  await redis.set(`drop:event:${dropId}`, state, { ex: appConfig.dropTtlSeconds });
  await redis.sadd("drops:active", dropId);
  await redis.set("drop:last_posted", dropId, { ex: env.luckyDropEventCooldownSeconds });

  return { posted: true };
}
