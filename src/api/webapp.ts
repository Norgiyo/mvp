import type { RequestLike, ResponseLike } from "../http/types";

import { env } from "../config";
import { buildAdWebAppHtml, getAdEvent, getNextMonetagZoneId } from "../services/ads";
import { html } from "../utils/http";

export async function handleAdWebApp(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "GET") {
    html(res, 405, "<h1>Method not allowed</h1>");
    return;
  }

  const eventId =
    typeof req.query.event === "string"
      ? req.query.event
      : typeof req.query.tgWebAppStartParam === "string"
        ? req.query.tgWebAppStartParam
        : null;
  if (!eventId) {
    html(res, 400, "<h1>Falta el evento</h1>");
    return;
  }

  try {
    const event = await getAdEvent(eventId);
    if (!event) {
      html(res, 410, "<h1>El anuncio ya no esta disponible</h1>");
      return;
    }

    const zoneId = await getNextMonetagZoneId();

    html(
      res,
      200,
      buildAdWebAppHtml({
        eventId,
        reward: event.reward,
        zoneId,
        sdkUrl: env.monetagSdkUrl,
        requestVar: env.monetagRequestVar
      })
    );
  } catch (error) {
    console.error("webapp_open_failed", error);
    html(
      res,
      400,
      "<h1>No se pudo abrir la Mini App</h1>"
    );
  }
}
