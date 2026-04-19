import crypto from "node:crypto";

import type { Api } from "grammy";

import { appConfig, env } from "../config";
import { redis } from "../db/redis";
import { registerTemporaryGroupMessage } from "../services/eventCleanup";
import type { BoostEventState } from "../types";
import { addSeconds } from "../utils/time";
import { encodeCallback } from "../utils/callbackData";

const BOOST_TTL_SECONDS = 60 * 60 * 24;
const BOOST_MAX_SLOTS = 100;

export async function postBoost(api: Api): Promise<{ posted: boolean }> {
  const boostId = crypto.randomUUID();
  const expiresAt = addSeconds(new Date(), BOOST_TTL_SECONDS).toISOString();

  const message = await api.sendMessage(
    env.groupChatId,
    "⚡",
    {
      disable_notification: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "ACTIVAR",
              callback_data: encodeCallback("boost", boostId),
              style: "primary"
            }
          ]
        ]
      }
    }
  );

  const state: BoostEventState = {
    id: boostId,
    messageId: message.message_id,
    expiresAt,
    maxSlots: BOOST_MAX_SLOTS
  };

  await redis.set(`boost:event:${boostId}`, state, { ex: BOOST_TTL_SECONDS });
  await redis.sadd("boosts:active", boostId);

  await registerTemporaryGroupMessage(
    "boost:msg",
    "boosts:active",
    boostId,
    message.message_id,
    expiresAt
  );

  return { posted: true };
}
