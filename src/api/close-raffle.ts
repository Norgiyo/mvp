import type { RequestLike, ResponseLike } from "../http/types";

import { getBot } from "../bot/bot";
import { runSerializedChannelPublish } from "../services/channelPublish";
import { closeRaffleAndAnnounce } from "../services/raffles";
import { json } from "../utils/http";
import { guardAdmin } from "./admin";

export async function handleCloseRaffle(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (!guardAdmin(req, res)) {
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  const raffleId =
    typeof req.query.id === "string"
      ? req.query.id
      : typeof body.id === "string"
        ? body.id
        : null;

  if (!raffleId) {
    json(res, 400, { ok: false, error: "Missing raffle id" });
    return;
  }

  const bot = await getBot();
  const result = await runSerializedChannelPublish("post_raffle_close", () =>
    closeRaffleAndAnnounce(bot.api, raffleId)
  );
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
  const closeResult = result.value;
  if (closeResult.status === "not_found") {
    json(res, 404, { ok: false, error: "Raffle not found" });
    return;
  }
  if (closeResult.status === "already_closed") {
    json(res, 409, { ok: false, error: "Raffle already closed" });
    return;
  }
  if (closeResult.status !== "closed") {
    json(res, 500, { ok: false, error: "Unexpected close raffle state" });
    return;
  }

  json(res, 200, { ok: true, ...closeResult });
}
