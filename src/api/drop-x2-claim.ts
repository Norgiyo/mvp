import type { RequestLike, ResponseLike } from "../http/types";

import { getBot } from "../bot/bot";
import { env } from "../config";
import { redis } from "../db/redis";
import { sql } from "../db/postgres";
import { claimLuckyDrop } from "../services/coins";
import { registerTemporaryGroupMessage } from "../services/eventCleanup";
import { getWebAppSessionUserId } from "../services/webappSession";
import type { LuckyDropState } from "../types";
import { addSeconds } from "../utils/time";
import { json } from "../utils/http";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mentionFromUser(user: { id: number; username?: string | null; first_name?: string | null }): string {
  const label =
    (typeof user.username === "string" && user.username.trim().length > 0
      ? `@${user.username.trim()}`
      : user.first_name?.trim() || `user_${user.id}`) ?? `user_${user.id}`;
  return `<a href="tg://user?id=${user.id}">${escapeHtml(label)}</a>`;
}

export async function handleDropX2Claim(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  const dropId = typeof body.dropId === "string" ? body.dropId : null;
  const adToken = typeof body.adToken === "string" ? body.adToken : null;
  const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken : null;

  if (!dropId || !adToken) {
    json(res, 400, { ok: false, error: "Missing dropId or adToken" });
    return;
  }

  try {
    const userId = await getWebAppSessionUserId(sessionToken);
    if (!userId) {
      json(res, 401, { ok: false, error: "Sesion de Mini App invalida o vencida." });
      return;
    }

    const usedKey = `drop:x2:token:used:${adToken}`;
    const alreadyUsed = await redis.get(usedKey);
    if (alreadyUsed) {
      json(res, 409, { ok: false, error: "Este anuncio ya fue usado para reclamar un drop." });
      return;
    }

    const adRows = await sql<{ status: string; user_id: number }[]>`
      select status, user_id
      from ad_claims
      where token = ${adToken}
      limit 1
    `;
    const adClaim = adRows[0];
    if (!adClaim) {
      json(res, 404, { ok: false, error: "Intento de anuncio no encontrado." });
      return;
    }
    if (Number(adClaim.user_id) !== userId) {
      json(res, 403, { ok: false, error: "Este intento pertenece a otra sesion." });
      return;
    }
    if (adClaim.status !== "rewarded") {
      json(res, 402, { ok: false, error: "El anuncio todavia no fue confirmado por Monetag." });
      return;
    }

    const drop = await redis.get<LuckyDropState>(`drop:event:${dropId}`);
    if (!drop || new Date(drop.expiresAt).getTime() <= Date.now()) {
      json(res, 410, { ok: false, error: "Este lucky drop ya no esta disponible." });
      return;
    }

    const claimResult = await claimLuckyDrop(dropId, userId, drop.reward * 2);
    if (claimResult.status === "duplicate") {
      json(res, 409, { ok: false, error: "Ya reclamaste este lucky drop." });
      return;
    }

    await redis.set(usedKey, "1", { ex: 86400 });
    await redis.del(`drop:event:${dropId}`);
    await redis.srem("drops:active", dropId);

    const bot = await getBot();

    const userRows = await sql<{ username: string | null; first_name: string | null }[]>`
      select username, first_name from users where telegram_id = ${userId} limit 1
    `;
    const userInfo = userRows[0];
    const from = { id: userId, username: userInfo?.username ?? null, first_name: userInfo?.first_name ?? null };

    const winnerMessage = await bot.api
      .sendMessage(
        env.groupChatId,
        `${mentionFromUser(from)} abrio el Lucky Drop x2 (via anuncio) y gano ${drop.reward * 2} coins.`,
        { disable_notification: true, parse_mode: "HTML" }
      )
      .catch(() => undefined);

    if (winnerMessage && "message_id" in winnerMessage) {
      await registerTemporaryGroupMessage(
        "drop:winner",
        "drop:winner:active",
        `${dropId}:${winnerMessage.message_id}`,
        winnerMessage.message_id,
        addSeconds(new Date(), 5 * 60).toISOString()
      ).catch(() => undefined);
    }

    await bot.api.deleteMessage(env.groupChatId, drop.messageId).catch(() => undefined);

    json(res, 200, { ok: true, reward: drop.reward * 2, balance: claimResult.balance });
  } catch (error) {
    console.error("drop_x2_claim_failed", error);
    json(res, 500, { ok: false, error: "Error interno al reclamar el drop." });
  }
}
