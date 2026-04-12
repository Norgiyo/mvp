import type { RequestLike, ResponseLike } from "../http/types";

import { getBot } from "../bot/bot";
import { guardAdmin } from "./admin";
import { runSerializedChannelPublish } from "../services/channelPublish";
import { createNextRaffle, RAFFLE_DEFAULT_ENTRY_COST } from "../services/raffles";
import { json } from "../utils/http";

function readInput(req: RequestLike): {
  title: string;
  prizeAmount: number;
  entryCost: number;
  endsAt: string;
} {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};

  const title = String(body.title ?? req.query.title ?? "Sorteo de La Esquina");
  const prizeAmount = Number(body.prizeAmount ?? req.query.prizeAmount ?? 500);
  const entryCost = Number(body.entryCost ?? req.query.entryCost ?? RAFFLE_DEFAULT_ENTRY_COST);
  const endsAt = String(
    body.endsAt ??
      req.query.endsAt ??
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  );

  return { title, prizeAmount, entryCost, endsAt };
}

export async function handleCreateRaffle(
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

  const bot = await getBot();
  const result = await runSerializedChannelPublish("post_raffle_create", () =>
    createNextRaffle(bot.api, readInput(req))
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
  json(res, 200, {
    ok: true,
    raffleId: result.value.raffle.id,
    messageId: result.value.raffle.messageId,
    replacedRaffleId: result.value.replacedRaffleId
  });
}
