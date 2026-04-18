import type { RequestLike, ResponseLike } from "../http/types";

import { env } from "../config";
import { buildAdWebAppHtml, buildDropX2WebAppHtml, getAdEvent, getNextMonetagZoneId } from "../services/ads";
import { redis } from "../db/redis";
import type { LuckyDropState } from "../types";
import { html } from "../utils/http";

export async function handleAdWebApp(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "GET") {
    html(res, 405, "<h1>Method not allowed</h1>");
    return;
  }

  const startParam =
    typeof req.query.event === "string"
      ? req.query.event
      : typeof req.query.tgWebAppStartParam === "string"
        ? req.query.tgWebAppStartParam
        : null;
  if (!startParam) {
    html(res, 400, "<h1>Falta el evento</h1>");
    return;
  }

  if (startParam.startsWith("dropx2_")) {
    const dropId = startParam.slice("dropx2_".length);
    try {
      const drop = await redis.get<LuckyDropState>(`drop:event:${dropId}`);
      if (!drop || new Date(drop.expiresAt).getTime() <= Date.now()) {
        html(res, 410, "<h1>Este lucky drop ya no esta disponible</h1>");
        return;
      }
      const zoneId = await getNextMonetagZoneId();
      html(
        res,
        200,
        buildDropX2WebAppHtml({
          dropId,
          dropReward: drop.reward,
          zoneId,
          sdkUrl: env.monetagSdkUrl,
          requestVar: env.monetagRequestVar
        })
      );
    } catch (error) {
      console.error("drop_x2_webapp_open_failed", error);
      html(res, 400, "<h1>No se pudo abrir la Mini App</h1>");
    }
    return;
  }

  try {
    const event = await getAdEvent(startParam);
    if (!event) {
      html(res, 410, "<h1>El anuncio ya no esta disponible</h1>");
      return;
    }

    const zoneId = await getNextMonetagZoneId();

    html(
      res,
      200,
      buildAdWebAppHtml({
        eventId: startParam,
        reward: event.reward,
        zoneId,
        sdkUrl: env.monetagSdkUrl,
        requestVar: env.monetagRequestVar
      })
    );
  } catch (error) {
    console.error("webapp_open_failed", error);
    html(res, 400, "<h1>No se pudo abrir la Mini App</h1>");
  }
}
