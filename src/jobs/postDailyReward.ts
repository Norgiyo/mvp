import type { Api } from "grammy";

import { env } from "../config";
import { redis } from "../db/redis";
import { registerDailyRewardMessage } from "../services/eventCleanup";
import { encodeCallback } from "../utils/callbackData";
import { todayKey } from "../utils/time";

const GIFT_EMOJI = String.fromCodePoint(0x1F381);
const COIN_EMOJI = String.fromCodePoint(0x1FA99);

export async function postDailyReward(api: Api): Promise<{ posted: boolean }> {
  const day = todayKey();
  const dedupe = await redis.set(`daily:posted:${day}`, "1", {
    nx: true,
    ex: 60 * 60 * 48
  });

  if (dedupe !== "OK") {
    return { posted: false };
  }

  const message = await api.sendMessage(
    env.groupChatId,
    `${GIFT_EMOJI} Daily reward\n\nReclama tu reward diario de +${env.dailyRewardCoins} ${COIN_EMOJI}`,
    {
      disable_notification: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `${GIFT_EMOJI} Reclamar +${env.dailyRewardCoins}`,
              callback_data: encodeCallback("daily", day),
              style: "success"
            }
          ]
        ]
      }
    }
  );
  await registerDailyRewardMessage(day, message.message_id);

  return { posted: true };
}
