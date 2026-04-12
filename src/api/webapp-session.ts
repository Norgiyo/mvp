import type { RequestLike, ResponseLike } from "../http/types";

import { getBot } from "../bot/bot";
import { canUseBot } from "../services/channelMembership";
import { createWebAppSession } from "../services/webappSession";
import { upsertUser } from "../services/users";
import { json } from "../utils/http";
import { toTelegramProfile } from "../utils/telegram";
import { validateTelegramInitData } from "../utils/webapp";

export async function handleWebAppSession(
  req: RequestLike,
  res: ResponseLike
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};

  try {
    const initData = validateTelegramInitData(body.initData);
    const bot = await getBot();
    const allowed = await canUseBot(bot.api, Number(initData.user.id));
    if (!allowed) {
      json(res, 403, {
        ok: false,
        error: "Tienes que seguir el canal para usar la Mini App."
      });
      return;
    }

    await upsertUser(toTelegramProfile(initData.user));

    const session = await createWebAppSession(Number(initData.user.id));
    json(res, 200, {
      ok: true,
      sessionToken: session.token,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    console.error("webapp_session_failed", error);
    json(res, 400, {
      ok: false,
      error: "No se pudo validar la sesion de Telegram."
    });
  }
}
