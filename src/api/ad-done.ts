import type { RequestLike, ResponseLike } from "../http/types";

import { env } from "../config";
import { getAdAttemptStatus } from "../services/ads";
import { getWebAppSessionUserId } from "../services/webappSession";
import { json } from "../utils/http";

export async function handleAdDone(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const token = typeof req.query.token === "string" ? req.query.token : null;
  if (!token) {
    json(res, 400, { ok: false, error: "Missing token" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken : null;

  try {
    const userId = await getWebAppSessionUserId(sessionToken);
    if (!userId) {
      json(res, 401, { ok: false, error: "Sesion de Mini App invalida o vencida." });
      return;
    }

    const clientState =
      body.clientState === "resolved" || body.clientState === "failed"
        ? body.clientState
        : undefined;
    const clientError = typeof body.clientError === "string" ? body.clientError : null;

    const result = await getAdAttemptStatus({
      token,
      userId,
      clientState,
      clientError
    });

    if (result.status === "not_found") {
      json(res, 404, { ok: false, error: "Intento inexistente." });
      return;
    }

    if (result.status === "invalid_user") {
      json(res, 403, { ok: false, error: "Este intento pertenece a otra sesion." });
      return;
    }

    if (result.status === "ok") {
      const state = result.attempt.status;
      const defaultMessage =
        state === "rewarded"
          ? `Reward acreditado. Saldo: ${result.balance} coins.`
          : state === "limit_reached"
            ? "El postback llego, pero ya alcanzaste el limite diario de anuncios."
            : state === "cooldown"
              ? `Ya llevas ${env.adThrottleAfterCount}+ anuncios hoy. Espera ${Math.floor(env.adThrottleCooldownSeconds / 60)} min entre anuncios.`
              : state === "expired"
                ? "El intento expiro antes de que llegue un postback valido."
                : result.attempt.lastRewardEventType === "not_valued" ||
                    result.attempt.lastRewardEventType === "non_valued"
                  ? "Monetag confirmo el intento, pero no salio valorizado."
                  : "Esperando el postback de Monetag.";

      json(res, 200, {
        ok: true,
        state,
        balance: result.balance,
        lastRewardEventType: result.attempt.lastRewardEventType,
        lastEventType: result.attempt.lastEventType,
        rewardedAt: result.attempt.rewardedAt,
        postbackReceivedAt: result.attempt.postbackReceivedAt,
        message: defaultMessage
      });
    }
  } catch (error) {
    console.error("ad_done_failed", error);
    json(res, 400, {
      ok: false,
      error: "No se pudo validar la sesion de Telegram."
    });
  }
}
