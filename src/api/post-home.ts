import type { RequestLike, ResponseLike } from "../http/types";

import { getBot } from "../bot/bot";
import { postHomeMessage } from "../bot/callbacks";
import { runSerializedChannelPublish } from "../services/channelPublish";
import { guardAdmin } from "./admin";
import { json } from "../utils/http";

export async function handlePostHome(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (!guardAdmin(req, res)) {
    return;
  }

  const bot = await getBot();
  const result = await runSerializedChannelPublish("post_home", () => postHomeMessage(bot.api));
  if (result.status === "busy") {
    json(res, 409, { ok: false, error: "Another channel publish is in progress." });
    return;
  }
  if (result.status === "duplicate") {
    json(res, 429, {
      ok: false,
      error: "This channel publish action just ran.",
      retryAfterSeconds: result.retryAfterSeconds
    });
    return;
  }

  json(res, 200, {
    ok: true,
    messageId: result.value,
    note: "Guarda este message_id si quieres fijarlo manualmente."
  });
}
