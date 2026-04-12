import type { RequestLike, ResponseLike } from "../http/types";

import { getBot } from "../bot/bot";
import { env } from "../config";
import { isChannelMember } from "../services/channelMembership";
import { createAdAttempt } from "../services/ads";
import { getWebAppSessionUserId } from "../services/webappSession";
import { json } from "../utils/http";

function formatWait(seconds: number): string {
  const safe = Math.max(1, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;

  if (minutes <= 0) {
    return `${rest}s`;
  }

  if (rest === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${rest}s`;
}

export async function handleAdAttempt(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  const eventId = typeof body.eventId === "string" ? body.eventId : null;
  const zoneId = typeof body.zoneId === "string" ? body.zoneId : null;
  const requestVar = typeof body.requestVar === "string" ? body.requestVar : undefined;
  const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken : null;

  if (!eventId) {
    json(res, 400, { ok: false, error: "Missing eventId" });
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
      json(res, 403, {
        ok: false,
        error: "Tienes que seguir dentro del canal para abrir anuncios."
      });
      return;
    }

    const result = await createAdAttempt({
      eventId,
      userId,
      zoneId,
      requestVar
    });

    if (result.status === "expired") {
      json(res, 410, { ok: false, error: "Este anuncio ya no esta disponible." });
      return;
    }

    if (result.status === "limit_reached") {
      json(res, 429, { ok: false, error: "Ya alcanzaste tu limite diario de anuncios." });
      return;
    }

    if (result.status === "cooldown") {
      json(res, 429, { ok: false, error: "Espera un momento antes de intentar otro anuncio." });
      return;
    }

    if (result.status === "throttled") {
      json(res, 429, {
        ok: false,
        error: `Despues del anuncio #${env.adThrottleAfterCount} debes esperar ${formatWait(result.retryAfterSeconds)} para el siguiente.`,
        retryAfterSeconds: result.retryAfterSeconds
      });
      return;
    }

    if (result.status === "invalid_zone") {
      json(res, 400, { ok: false, error: "La zona Monetag no es valida para este deployment." });
      return;
    }

    if (result.status === "ok") {
      json(res, 200, {
        ok: true,
        token: result.attempt.token,
        ymid: result.attempt.ymid,
        zoneId: result.attempt.zoneId,
        reward: result.attempt.rewardAmount,
        expiresAt: result.attempt.expiresAt
      });
    }
  } catch (error) {
    console.error("ad_attempt_failed", error);
    json(res, 400, {
      ok: false,
      error: "No se pudo validar la sesion de Telegram."
    });
  }
}
