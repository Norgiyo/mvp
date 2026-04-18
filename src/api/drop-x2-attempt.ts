import type { RequestLike, ResponseLike } from "../http/types";

import { getBot } from "../bot/bot";
import { isChannelMember } from "../services/channelMembership";
import { createDropX2AdAttempt } from "../services/ads";
import { getWebAppSessionUserId } from "../services/webappSession";
import { json } from "../utils/http";

export async function handleDropX2Attempt(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  const dropId = typeof body.dropId === "string" ? body.dropId : null;
  const zoneId = typeof body.zoneId === "string" ? body.zoneId : null;
  const requestVar = typeof body.requestVar === "string" ? body.requestVar : undefined;
  const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken : null;

  if (!dropId) {
    json(res, 400, { ok: false, error: "Missing dropId" });
    return;
  }
  if (!zoneId) {
    json(res, 400, { ok: false, error: "Missing zoneId" });
    return;
  }

  try {
    const userId = await getWebAppSessionUserId(sessionToken);
    if (!userId) {
      json(res, 401, { ok: false, error: "Sesion de Mini App invalida o vencida." });
      return;
    }

    const bot = await getBot();
    const isMember = await isChannelMember(bot.api, userId);
    if (!isMember) {
      json(res, 403, { ok: false, error: "Tienes que seguir dentro del canal para abrir anuncios." });
      return;
    }

    const result = await createDropX2AdAttempt({ dropId, userId, zoneId, requestVar });

    if (result.status === "invalid_zone") {
      json(res, 400, { ok: false, error: "La zona Monetag no es valida para este deployment." });
      return;
    }

    if (result.status === "cooldown") {
      json(res, 429, { ok: false, error: "Espera un momento antes de intentar otro anuncio." });
      return;
    }

    if (result.status === "ok") {
      json(res, 200, {
        ok: true,
        token: result.attempt.token,
        ymid: result.attempt.ymid,
        zoneId: result.attempt.zoneId,
        expiresAt: result.attempt.expiresAt
      });
    }
  } catch (error) {
    console.error("drop_x2_attempt_failed", error);
    json(res, 400, { ok: false, error: "No se pudo validar la sesion de Telegram." });
  }
}
