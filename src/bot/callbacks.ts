import type { InlineKeyboardMarkup } from "@grammyjs/types";
import type { Api, Context } from "grammy";

import { env } from "../config";
import { redis } from "../db/redis";
import { maybePostAd } from "../jobs/maybePostAd";
import { postDailyBirthdays } from "../jobs/postDailyBirthdays";
import { maybePostLuckyDrop } from "../jobs/maybePostLuckyDrop";
import { postDailyReward } from "../jobs/postDailyReward";
import { runWeeklyLeaderboard } from "../jobs/postWeeklyLeaderboard";
import { markGroupActivity } from "../services/activity";
import { acquireCooldown, checkCallbackRateLimit, withRedisLock } from "../services/antiAbuse";
import { parseAuctionPayload, placeAuctionBid, postAuction } from "../services/auction";
import { mentionBirthdayUser, sendBirthdayGift } from "../services/birthdays";
import { runSerializedChannelPublish } from "../services/channelPublish";
import { isChannelMember } from "../services/channelMembership";
import { claimDailyReward, claimLuckyDrop } from "../services/coins";
import { cleanupExpiredEventMessages, registerTemporaryGroupMessage } from "../services/eventCleanup";

import {
  adjustFondoCupRate,
  donateCoinsToFondo,
  getFondoCupRate,
  getFondoSummary,
  getFondoValue,
  setFondoCupRate
} from "../services/fondo";
import { closeActiveMiningAndAnnounce, createNextMiningEvent, mineOre } from "../services/mining";
import {
  closeRaffleAndAnnounce,
  createNextRaffle,
  getLatestActiveRaffleId,
  joinRaffle,
  RAFFLE_DEFAULT_ENTRY_COST,
  RAFFLE_MAX_ENTRIES_PER_USER
} from "../services/raffles";

import { getBalance, getUserPublicProfile, isAdminUser, upsertUser } from "../services/users";
import type { LuckyDropState } from "../types";
import { decodeCallback, encodeCallback } from "../utils/callbackData";
import { addSeconds, todayKey } from "../utils/time";
import { toTelegramProfile } from "../utils/telegram";

const HOME_MESSAGE_TEXT =
  "La Esquina\n\nToca el boton para consultar tu saldo. El Fondo se publica aparte como mensaje.";
const ADMIN_PANEL_TEXT =
  "Panel privado de admin\n\nDesde aqui puedes publicar eventos y ejecutar acciones de admin.";
const FONDO_DONATION_AMOUNTS = [100] as const;
const COIN_EMOJI = String.fromCodePoint(0x1FA99);

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

async function answerToast(ctx: Context, text: string): Promise<void> {
  if (!ctx.callbackQuery) {
    return;
  }

  try {
    await ctx.api.answerCallbackQuery(ctx.callbackQuery.id, {
      text,
      show_alert: false
    });
  } catch {
    // Callback may already be answered or expired.
  }
}

async function runAdminChannelPublish<T>(
  ctx: Context,
  action: string,
  work: () => Promise<T>
): Promise<T | null> {
  const result = await runSerializedChannelPublish(action, work);
  if (result.status === "busy") {
    await answerToast(ctx, "Ya hay una publicacion del canal en curso. Espera un momento.");
    return null;
  }

  if (result.status === "duplicate") {
    await answerToast(
      ctx,
      `Esa accion acaba de ejecutarse. Espera ${Math.max(1, result.retryAfterSeconds)}s.`
    );
    return null;
  }

  return result.value;
}

export function buildHomeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: `${COIN_EMOJI} Monedero`,
          callback_data: encodeCallback("balance"),
          style: "primary"
        }
      ]
    ]
  };
}

export async function postHomeMessage(api: Api): Promise<number> {
  const message = await api.sendMessage(env.groupChatId, HOME_MESSAGE_TEXT, {
    disable_notification: true,
    reply_markup: buildHomeKeyboard()
  });

  return message.message_id;
}

export function buildAdminKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Home", callback_data: encodeCallback("admin", "post_home"), style: "primary" },
        { text: "Fondo", callback_data: encodeCallback("admin", "post_fondo_donation"), style: "danger" }
      ],
      [
        { text: "Tasa Fondo", callback_data: encodeCallback("admin", "fondo_rate_panel"), style: "primary" }
      ],
      [
        { text: "Daily", callback_data: encodeCallback("admin", "post_daily"), style: "success" },
        { text: "Anuncio", callback_data: encodeCallback("admin", "post_ad"), style: "primary" }
      ],
      [
        { text: "Lucky drop", callback_data: encodeCallback("admin", "post_drop"), style: "success" }
      ],
      [
        { text: "Cumpleanos", callback_data: encodeCallback("admin", "post_birthdays"), style: "success" }
      ],
      [
        { text: "Subasta", callback_data: encodeCallback("admin", "post_auction"), style: "primary" }
      ],
      [
        { text: "Mineria", callback_data: encodeCallback("admin", "post_mining_create"), style: "success" },
        { text: "Leaderboard semanal", callback_data: encodeCallback("admin", "post_weekly_leaderboard"), style: "success" }
      ],
      [
        { text: "Crear rifa", callback_data: encodeCallback("admin", "post_raffle_create"), style: "primary" },
        { text: "Cerrar mineria", callback_data: encodeCallback("admin", "post_mining_close"), style: "danger" }
      ],
      [
        { text: "Cerrar rifa", callback_data: encodeCallback("admin", "post_raffle_close"), style: "danger" },
        { text: "Panel", callback_data: encodeCallback("admin", "panel"), style: "danger" }
      ]
    ]
  };
}

export async function sendAdminPanel(api: Api, userId: number): Promise<number> {
  const message = await api.sendMessage(userId, ADMIN_PANEL_TEXT, {
    disable_notification: true,
    reply_markup: buildAdminKeyboard()
  });

  return message.message_id;
}

function buildFondoRateKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "-10", callback_data: encodeCallback("admin", "fondo_rate_adjust|-10"), style: "danger" },
        { text: "+10", callback_data: encodeCallback("admin", "fondo_rate_adjust|10"), style: "success" }
      ],
      [
        { text: "Actualizar", callback_data: encodeCallback("admin", "fondo_rate_panel"), style: "primary" },
        { text: "Volver", callback_data: encodeCallback("admin", "panel"), style: "danger" }
      ]
    ]
  };
}

async function buildFondoRatePanelText(): Promise<string> {
  const summary = await getFondoSummary();
  return [
    "<b>Tasa del Fondo</b>",
    "",
    `Tasa actual: <b>${summary.rate}</b> CUP por USD`,
    `Fondo visible: <b>${summary.formattedValue}</b>`,
    `Base guardada: <b>${summary.amountUsd.toFixed(6)} USD</b>`,
    "",
    "Usa los botones para subir, bajar o fijar la tasa del dia."
  ].join("\n");
}

async function showFondoRatePanel(ctx: Context, userId: number): Promise<void> {
  const text = await buildFondoRatePanelText();
  const message = ctx.callbackQuery?.message;
  if (message?.chat?.id === userId && "message_id" in message) {
    await ctx.api
      .editMessageText(userId, message.message_id, text, {
        parse_mode: "HTML",
        reply_markup: buildFondoRateKeyboard()
      })
      .catch(async () => {
        await ctx.api.sendMessage(userId, text, {
          disable_notification: true,
          parse_mode: "HTML",
          reply_markup: buildFondoRateKeyboard()
        });
      });
    return;
  }

  await ctx.api.sendMessage(userId, text, {
    disable_notification: true,
    parse_mode: "HTML",
    reply_markup: buildFondoRateKeyboard()
  });
}

function isAllowedFondoDonationAmount(
  amount: number
): amount is (typeof FONDO_DONATION_AMOUNTS)[number] {
  return FONDO_DONATION_AMOUNTS.some((value) => value === amount);
}

async function postFondoDonationMessage(api: Api, amount: (typeof FONDO_DONATION_AMOUNTS)[number]): Promise<number> {
  const fondo = await getFondoValue();
  const message = await api.sendMessage(
    env.groupChatId,
    `<b>Fondo del barrio</b>\n\nFondo actual: <b>${fondo}</b>\n\n<blockquote>Apoya el Fondo con una donacion directa de <b>${amount} coins</b>.</blockquote>`,
    {
      disable_notification: true,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: `Donar -${amount} ${COIN_EMOJI}`, callback_data: encodeCallback("fondo", `donate|${amount}`), style: "danger" }]
        ]
      }
    }
  );

  return message.message_id;
}
export async function handleCallbackQuery(ctx: Context): Promise<void> {
  const query = ctx.callbackQuery;
  if (!query?.from || !("data" in query)) {
    return;
  }

  if (query.message?.chat.id === env.groupChatId) {
    void markGroupActivity().catch(() => undefined);
    void cleanupExpiredEventMessages(ctx.api).catch(() => undefined);
  }

  const from = query.from;
  const isChannelCallback = query.message?.chat.id === env.groupChatId;
  if (isChannelCallback) {
    const isMember = await isChannelMember(ctx.api, from.id);
    if (!isMember) {
      await answerToast(ctx, "Unete al canal para usar este boton.");
      return;
    }
  }

  await upsertUser(toTelegramProfile(from));

  const allowed = await checkCallbackRateLimit(from.id);
  if (!allowed) {
    await answerToast(ctx, "Muy rapido. Espera unos segundos.");
    return;
  }

  const payload = decodeCallback(query.data);
  if (!payload) {
    await answerToast(ctx, "Accion invalida.");
    return;
  }

  try {
    switch (payload.action) {
      case "balance": {
        const profile = await getUserPublicProfile(from.id);
        const balance = profile?.balance ?? (await getBalance(from.id));
        const titleSuffix = profile?.specialTitle ? ` | Titulo: ${profile.specialTitle}` : "";
        await answerToast(ctx, `Tu saldo actual es ${balance}${titleSuffix}`);
        return;
      }

      case "fondo": {
        if (typeof payload.value === "string" && payload.value.startsWith("donate|")) {
          const [, rawAmount] = payload.value.split("|");
          const amount = Number.parseInt(rawAmount ?? "", 10);
          if (!Number.isFinite(amount) || !isAllowedFondoDonationAmount(amount)) {
            await answerToast(ctx, "Monto de donacion invalido.");
            return;
          }

          const allowedByCooldown = await acquireCooldown("fondo_donate", from.id, 2);
          if (!allowedByCooldown) {
            await answerToast(ctx, "Espera un momento antes de volver a donar.");
            return;
          }

          const donation = await donateCoinsToFondo(from.id, amount);
          if (donation.status === "invalid_amount") {
            await answerToast(ctx, "Monto de donacion invalido.");
            return;
          }
          if (donation.status === "insufficient_balance") {
            await answerToast(ctx, "No tienes saldo suficiente para donar.");
            return;
          }
          if (donation.status !== "ok") {
            await answerToast(ctx, "Donacion no disponible temporalmente.");
            return;
          }

          await ctx.api
            .sendMessage(
              env.groupChatId,
              `${mentionFromUser(from)} acaba de donar ${amount} coins al Fondo. Fondo: ${donation.fondo}.`,
              {
                disable_notification: true,
                parse_mode: "HTML"
              }
            )
            .catch(() => undefined);

          await answerToast(
            ctx,
            `Donaste ${amount} al Fondo. Saldo: ${donation.balance}. Fondo: ${donation.fondo}`
          );
          return;
        }

        const fondo = await getFondoValue();
        await answerToast(ctx, `El Fondo actual: ${fondo}`);
        return;
      }

      case "daily": {
        const dayKey = payload.value;
        if (!dayKey || dayKey !== todayKey()) {
          const message = query.message;
          if (message && "message_id" in message) {
            await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
          }
          await answerToast(ctx, "Este daily ya vencio.");
          return;
        }

        const result = await claimDailyReward(from.id, dayKey);
        if (result.status === "duplicate") {
          await answerToast(ctx, "Hoy ya reclamaste tu daily.");
          return;
        }

        await answerToast(
          ctx,
          `Daily +${result.rewardAmount}. Racha ${result.streakDays} dias (x${result.multiplier}). Saldo: ${result.balance}`
        );
        return;
      }

      case "drop": {
        const dropId = payload.value;
        if (!dropId) {
          await answerToast(ctx, "Drop invalido.");
          return;
        }

        const claimResult = await withRedisLock(`drop:claim:${dropId}`, 5, async () => {
          const drop = await redis.get<LuckyDropState>(`drop:event:${dropId}`);
          if (!drop || new Date(drop.expiresAt).getTime() <= Date.now()) {
            return { status: "expired" as const };
          }

          const result = await claimLuckyDrop(dropId, from.id, drop.reward);
          if (result.status === "duplicate") {
            return { status: "duplicate" as const };
          }

          await redis.del(`drop:event:${dropId}`);
          await redis.srem("drops:active", dropId);

          const winnerMessage = await ctx.api
            .sendMessage(
              env.groupChatId,
              `${mentionFromUser(from)} acaba de ganar ${drop.reward} coins en el Lucky Drop.`,
              {
                disable_notification: true,
                parse_mode: "HTML"
              }
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

          const message = query.message;
          if (message && "message_id" in message) {
            await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
          }

          return { status: "ok" as const, balance: result.balance };
        });

        if (claimResult === null) {
          await answerToast(ctx, "Alguien esta agarrando este lucky drop.");
          return;
        }

        if (claimResult.status === "expired") {
          const message = query.message;
          if (message && "message_id" in message) {
            await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
          }
          await answerToast(ctx, "Este lucky drop ya no esta disponible.");
          return;
        }

        if (claimResult.status === "duplicate") {
          await answerToast(ctx, "Ya agarraste este lucky drop.");
          return;
        }

        await answerToast(ctx, `Drop reclamado. Saldo: ${claimResult.balance}`);
        return;
      }

      case "mining": {
        const eventId = payload.value;
        if (!eventId) {
          await answerToast(ctx, "Mina invalida.");
          return;
        }

        const result = await mineOre(ctx.api, eventId, from.id);
        if (result.status === "not_found") {
          const message = query.message;
          if (message && "message_id" in message) {
            await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
          }
          await answerToast(ctx, "Esta mina ya no esta activa.");
          return;
        }
        if (result.status === "busy") {
          await answerToast(ctx, "La mina se esta actualizando. Prueba otra vez.");
          return;
        }
        if (result.status === "cooldown") {
          await answerToast(ctx, `Tu pico se enfria. Vuelve en ${Math.max(1, result.retryAfterSeconds)}s.`);
          return;
        }
        if (result.status !== "mined") {
          await answerToast(ctx, "La mina ya no esta disponible.");
          return;
        }

        await answerToast(
          ctx,
          result.depleted
            ? `Sacaste ${result.extracted}. La mina se agoto.`
            : `Sacaste ${result.extracted}. Quedan ${result.remainingOre}/${result.totalOre}.`
        );
        return;
      }

      case "birthday": {
        const eventId = payload.value;
        if (!eventId) {
          await answerToast(ctx, "Cumpleanos invalido.");
          return;
        }

        const result = await sendBirthdayGift(eventId, from.id);
        if (result.status === "not_found" || result.status === "expired") {
          const message = query.message;
          if (message && "message_id" in message) {
            await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
          }
          await answerToast(ctx, "Este cumpleanos ya vencio.");
          return;
        }
        if (result.status === "duplicate") {
          await answerToast(ctx, "Ya le mandaste tu regalo hoy.");
          return;
        }
        if (result.status === "insufficient_balance") {
          await answerToast(ctx, "No tienes saldo suficiente para regalar.");
          return;
        }
        if (result.status === "self_gift_not_allowed") {
          await answerToast(ctx, "Otro usuario debe mandarle el regalo.");
          return;
        }
        if (result.status !== "ok") {
          await answerToast(ctx, "Este regalo ya no esta disponible.");
          return;
        }

        await ctx.api
          .sendMessage(
            env.groupChatId,
            `${mentionFromUser(from)} le regalo ${result.amount} coins a ${mentionBirthdayUser(result)} por su cumpleanos.`,
            {
              disable_notification: true,
              parse_mode: "HTML"
            }
          )
          .catch(() => undefined);

        await answerToast(ctx, `Regalo enviado. Saldo: ${result.giverBalance}`);
        return;
      }

      case "auction": {
        const auction = parseAuctionPayload(payload.value);
        if (!auction) {
          await answerToast(ctx, "Subasta invalida.");
          return;
        }

        const result = await placeAuctionBid(ctx.api, auction.eventId, from.id, auction.step);
        if (result.status === "not_found") {
          const message = query.message;
          if (message && "message_id" in message) {
            await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
          }
          await answerToast(ctx, "Esta subasta ya no esta disponible.");
          return;
        }
        if (result.status === "busy") {
          await answerToast(ctx, "Espera un segundo y prueba otra vez.");
          return;
        }
        if (result.status === "already_leading") {
          await answerToast(ctx, "Ya vas ganando la subasta.");
          return;
        }
        if (result.status === "too_low") {
          await answerToast(ctx, "Tu puja no supera el precio actual.");
          return;
        }
        if (result.status === "insufficient_balance") {
          await answerToast(ctx, "No tienes saldo suficiente para esa puja.");
          return;
        }
        if (result.status === "won") {
          await answerToast(
            ctx,
            result.winnerId === from.id
              ? `La subasta cerro y ganaste ${result.prize} coins.`
              : `La subasta ya cerro. Gano ${result.winnerLabel}.`
          );
          return;
        }
        if (result.status === "no_bids") {
          await answerToast(ctx, "La subasta ya cerro.");
          return;
        }

        if (result.status !== "placed") {
          await answerToast(ctx, "La subasta ya no esta disponible.");
          return;
        }

        await answerToast(ctx, `Puja lider: ${result.price}. Cierra en 2 min. Saldo: ${result.balance}`);
        return;
      }

      case "raffle": {
        const raffleId = payload.value;
        if (!raffleId) {
          await answerToast(ctx, "Sorteo invalido.");
          return;
        }

        const result = await joinRaffle(raffleId, from.id);
        if (result.status === "not_found") {
          await answerToast(ctx, "No encontre ese sorteo.");
          return;
        }
        if (result.status === "closed") {
          const message = query.message;
          if (message && "message_id" in message) {
            await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
          }
          await answerToast(ctx, "Ese sorteo ya cerro.");
          return;
        }
        if (result.status === "entry_limit_reached") {
          await answerToast(ctx, `Llegaste al limite de ${RAFFLE_MAX_ENTRIES_PER_USER} entradas en esta rifa.`);
          return;
        }
        if (result.status === "insufficient_balance") {
          await answerToast(ctx, "No tienes saldo suficiente.");
          return;
        }
        if (result.status === "ok") {
          await answerToast(
            ctx,
            `Entrada ${result.entriesUsed}/${RAFFLE_MAX_ENTRIES_PER_USER} registrada. Costo ${result.entryCost}. Saldo: ${result.balance}`
          );
        }
        return;
      }

      case "admin": {
        if (!(await isAdminUser(from.id))) {
          await answerToast(ctx, "No tienes acceso a este panel.");
          return;
        }

        if (typeof payload.value === "string" && payload.value.startsWith("fondo_add|")) {
          await answerToast(ctx, "La carga manual al Fondo fue desactivada.");
          return;
        }

        if (typeof payload.value === "string" && payload.value.startsWith("fondo_rate_set|")) {
          const rawRate = payload.value.split("|")[1];
          const rate = Number.parseInt(rawRate ?? "", 10);
          if (!Number.isFinite(rate) || rate <= 0) {
            await answerToast(ctx, "Tasa invalida.");
            return;
          }

          await setFondoCupRate(rate);
          await showFondoRatePanel(ctx, from.id);
          await answerToast(ctx, `Tasa del Fondo: ${rate}`);
          return;
        }

        if (typeof payload.value === "string" && payload.value.startsWith("fondo_rate_adjust|")) {
          const rawDelta = payload.value.split("|")[1];
          const delta = Number.parseInt(rawDelta ?? "", 10);
          if (!Number.isFinite(delta) || delta === 0) {
            await answerToast(ctx, "Ajuste invalido.");
            return;
          }

          const rate = await adjustFondoCupRate(delta);
          await showFondoRatePanel(ctx, from.id);
          await answerToast(ctx, `Tasa del Fondo: ${rate}`);
          return;
        }

        switch (payload.value) {
          case "panel": {
            await sendAdminPanel(ctx.api, from.id);
            await answerToast(ctx, "Panel actualizado.");
            return;
          }

          case "fondo_rate_panel": {
            await showFondoRatePanel(ctx, from.id);
            await answerToast(ctx, `Tasa actual: ${await getFondoCupRate()}`);
            return;
          }

          case "post_home": {
            const messageId = await runAdminChannelPublish(ctx, "post_home", () => postHomeMessage(ctx.api));
            if (messageId === null) {
              return;
            }
            await answerToast(ctx, `Home publicado (#${messageId}).`);
            return;
          }

          case "post_daily": {
            const dailyResult = await runAdminChannelPublish(ctx, "post_daily", () => postDailyReward(ctx.api));
            if (dailyResult === null) {
              return;
            }
            await answerToast(ctx, dailyResult.posted ? "Daily publicado." : "Daily de hoy ya existe.");
            return;
          }

          case "post_birthdays": {
            const result = await runAdminChannelPublish(ctx, "post_birthdays", () => postDailyBirthdays(ctx.api));
            if (result === null) {
              return;
            }
            if (result.totalBirthdays === 0) {
              await answerToast(ctx, "No hay cumpleanos hoy.");
              return;
            }

            await answerToast(
              ctx,
              result.postedCount > 0
                ? `Cumpleanos publicados: ${result.postedCount}.`
                : "Los cumpleanos de hoy ya estaban publicados."
            );
            return;
          }



          case "post_ad": {
            const result = await runAdminChannelPublish(ctx, "post_ad", () => maybePostAd(ctx.api, { force: true }));
            if (result === null) {
              return;
            }
            await answerToast(ctx, result.posted ? "Anuncio publicado." : "No pude publicar el anuncio.");
            return;
          }

          case "post_drop": {
            const result = await runAdminChannelPublish(ctx, "post_drop", () =>
              maybePostLuckyDrop(ctx.api, { force: true })
            );
            if (result === null) {
              return;
            }
            await answerToast(ctx, result.posted ? "Lucky drop publicado." : "No pude publicar el lucky drop.");
            return;
          }

          case "post_auction": {
            const result = await runAdminChannelPublish(ctx, "post_auction", () => postAuction(ctx.api));
            if (result === null) {
              return;
            }
            const replacementText =
              result.replaced && result.refunded
                ? `Subasta anterior reemplazada y puja devuelta. Nuevo mensaje (#${result.messageId}).`
                : result.replaced
                  ? `Subasta anterior reemplazada. Nuevo mensaje (#${result.messageId}).`
                  : `Subasta publicada (#${result.messageId}).`;
            await answerToast(ctx, replacementText);
            return;
          }

          case "post_mining_create": {
            const result = await runAdminChannelPublish(ctx, "post_mining_create", () =>
              createNextMiningEvent(ctx.api)
            );
            if (result === null) {
              return;
            }
            await answerToast(
              ctx,
              result.replaced
                ? "Mina anterior cerrada. Nueva mineria publicada."
                : "Mineria publicada."
            );
            return;
          }

          case "post_mining_close": {
            const result = await runAdminChannelPublish(ctx, "post_mining_close", () =>
              closeActiveMiningAndAnnounce(ctx.api, "manual")
            );
            if (result === null) {
              return;
            }
            if (result.status === "not_found") {
              await answerToast(ctx, "No hay mineria activa.");
              return;
            }

            await answerToast(ctx, "Mineria cerrada y resultado publicado.");
            return;
          }

          case "post_fondo_donation": {
            const messageId = await runAdminChannelPublish(ctx, "post_fondo_donation", () =>
              postFondoDonationMessage(ctx.api, 100)
            );
            if (messageId === null) {
              return;
            }
            await answerToast(ctx, `Mensaje del Fondo publicado (#${messageId}).`);
            return;
          }

          case "post_weekly_leaderboard": {
            const result = await runAdminChannelPublish(ctx, "post_weekly_leaderboard", () =>
              runWeeklyLeaderboard(ctx.api)
            );
            if (result === null) {
              return;
            }
            await answerToast(
              ctx,
              result.winnerId
                ? result.bonusGiven
                  ? "Leaderboard semanal publicado y bonus entregado."
                  : "Leaderboard semanal publicado (bonus ya entregado esta semana)."
                : "Leaderboard semanal publicado (sin participantes)."
            );
            return;
          }

          case "post_raffle_create": {
            const result = await runAdminChannelPublish(ctx, "post_raffle_create", () =>
              createNextRaffle(ctx.api, {
                title: "Sorteo del barrio",
                prizeAmount: 500,
                entryCost: RAFFLE_DEFAULT_ENTRY_COST,
                endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
              })
            );
            if (result === null) {
              return;
            }
            await answerToast(
              ctx,
              result.replacedRaffleId
                ? `Rifa anterior cerrada. Nueva rifa creada (#${result.raffle.id.slice(0, 8)}).`
                : `Rifa creada (#${result.raffle.id.slice(0, 8)}).`
            );
            return;
          }

          case "post_raffle_close": {
            const raffleId = await getLatestActiveRaffleId();
            if (!raffleId) {
              await answerToast(ctx, "No hay rifas activas.");
              return;
            }

            const result = await runAdminChannelPublish(ctx, "post_raffle_close", () =>
              closeRaffleAndAnnounce(ctx.api, raffleId)
            );
            if (result === null) {
              return;
            }
            if (result.status !== "closed") {
              await answerToast(ctx, "No pude cerrar la rifa activa.");
              return;
            }

            await answerToast(
              ctx,
              result.winnerId ? "Rifa cerrada y ganador anunciado." : "Rifa cerrada sin participantes."
            );
            return;
          }
        }

        await answerToast(ctx, "Accion admin invalida.");
        return;
      }
    }
  } catch (error) {
    console.error("callback_query_failed", {
      action: payload.action,
      value: payload.value ?? null,
      userId: from.id,
      error: error instanceof Error ? error.message : String(error)
    });

    await answerToast(ctx, "Error temporal. Intenta de nuevo.");
  }
}
