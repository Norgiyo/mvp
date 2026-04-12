import type { RequestLike, ResponseLike } from "../http/types";

import { getBot } from "./bot";
import { env } from "../config";
import { markUpdateSeen } from "../services/antiAbuse";
import { cleanupExpiredEventMessages } from "../services/eventCleanup";
import { json } from "../utils/http";
import { matchesAnySecret } from "../utils/secrets";

type TelegramUpdate = {
  update_id?: number;
};

function isTelegramWebhook(req: RequestLike): boolean {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  return typeof secret === "string" && matchesAnySecret(secret, env.telegramWebhookSecrets);
}

export async function handleTelegramWebhook(
  req: RequestLike,
  res: ResponseLike
): Promise<void> {
  try {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    if (!isTelegramWebhook(req)) {
      json(res, 401, { ok: false, error: "Invalid webhook secret" });
      return;
    }

    const update = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as TelegramUpdate;
    if (!update?.update_id) {
      json(res, 400, { ok: false, error: "Invalid Telegram update" });
      return;
    }

    const firstSeen = await markUpdateSeen(update.update_id);
    if (!firstSeen) {
      json(res, 200, { ok: true, duplicate: true });
      return;
    }

    const bot = await getBot();
    await cleanupExpiredEventMessages(bot.api);

    await bot.handleUpdate(update as never);
    json(res, 200, { ok: true });
  } catch (error) {
    console.error("telegram_webhook_failed", error);
    json(res, 500, {
      ok: false,
      error: "Internal server error"
    });
  }
}
