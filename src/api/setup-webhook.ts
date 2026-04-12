import type { RequestLike, ResponseLike } from "../http/types";

import { appConfig, env } from "../config";
import { guardAdmin } from "./admin";
import { json } from "../utils/http";

export async function handleSetupWebhook(
  req: RequestLike,
  res: ResponseLike
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (!guardAdmin(req, res)) {
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${env.botToken}/setWebhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      url: `${env.appUrl}/api/webhook`,
      secret_token: env.telegramWebhookSecret,
      allowed_updates: appConfig.allowedUpdates
    })
  });

  const payload = await response.json();
  json(res, response.ok ? 200 : 400, payload);
}
