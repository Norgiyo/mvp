import crypto from "node:crypto";

import type { Api } from "grammy";

import { appConfig, env } from "../config";
import { redis } from "../db/redis";
import { sql } from "../db/postgres";
import type { AuctionState } from "../types";
import { withRedisLock } from "./antiAbuse";
import { creditUserInTx, debitUserInTx } from "./coins";
import { getUserPublicProfile } from "./users";
import { encodeCallback } from "../utils/callbackData";
import { addSeconds } from "../utils/time";

type Tx = any;

export type AuctionBidStep = 10 | 25 | 50 | "allin";

const AUCTION_PRIZE_COINS = 500;
const AUCTION_BASE_PRICE = 80;
const COIN_EMOJI = String.fromCodePoint(0x1FA99);

function auctionStateKey(): string {
  return "auction:state";
}

function auctionEscapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAuctionActor(state: AuctionState): string {
  if (!state.highestBidderId) {
    return "sin puja";
  }

  const label = state.highestBidderUsername
    ? `@${state.highestBidderUsername}`
    : state.highestBidderFirstName || `user_${state.highestBidderId}`;

  return `<a href="tg://user?id=${state.highestBidderId}">${auctionEscapeHtml(label)}</a>`;
}

function formatAuctionRemaining(expiresAt: string): string {
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
  }

  return `${minutes}m ${seconds}s`;
}

function auctionText(state: AuctionState): string {
  return [
    "<b>SUBASTA ACTIVA</b>",
    `Premio: <b>${state.prizeCoins} coins del Fondo</b>`,
    `Precio actual: <b>${state.currentPrice}</b> coins - ${formatAuctionActor(state)}`,
    `Cierra en: <b>${formatAuctionRemaining(state.expiresAt)}</b>`,
    "",
    "Cada puja sube el precio y reinicia el contador 2 minutos.",
    "El ultimo en pujar antes de que expire gana."
  ].join("\n");
}

function auctionMarkup(eventId: string) {
  return {
    inline_keyboard: [
      [
        {
          text: `Pujar (-10 ${COIN_EMOJI})`,
          callback_data: encodeCallback("auction", `${eventId}|10`),
          style: "primary" as const
        }
      ]
    ]
  };
}

function parseStateTtlSeconds(expiresAt: string): number {
  const remaining = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000);
  return Math.max(60, remaining + 60 * 60);
}

async function getAuctionState(): Promise<AuctionState | null> {
  return redis.get<AuctionState>(auctionStateKey());
}

async function saveAuctionState(state: AuctionState): Promise<void> {
  await redis.set(auctionStateKey(), state, { ex: parseStateTtlSeconds(state.expiresAt) });
}

async function deleteAuctionState(): Promise<void> {
  await redis.del(auctionStateKey());
}

async function updateAuctionMessage(api: Api, state: AuctionState): Promise<void> {
  await api
    .editMessageText(state.chatId, state.messageId, auctionText(state), {
      parse_mode: "HTML",
      reply_markup: auctionMarkup(state.id)
    })
    .catch(() => undefined);
}

async function clearAuctionMessage(api: Api, state: AuctionState): Promise<void> {
  await api.deleteMessage(state.chatId, state.messageId).catch(() => undefined);
}

function resolveBidStep(rawValue: string | undefined): AuctionBidStep | null {
  if (rawValue === "allin") {
    return "allin";
  }

  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (parsed === 10 || parsed === 25 || parsed === 50) {
    return parsed;
  }

  return null;
}

function computeNextBidPrice(
  state: AuctionState,
  step: AuctionBidStep,
  availableBalance: number,
  currentBidderIsActor: boolean
): number | null {
  const totalSpendable = currentBidderIsActor ? availableBalance + state.currentPrice : availableBalance;

  if (step === "allin") {
    if (!state.highestBidderId) {
      return totalSpendable >= state.currentPrice ? totalSpendable : null;
    }
    return totalSpendable > state.currentPrice ? totalSpendable : null;
  }

  const target = state.currentPrice + step;
  return totalSpendable >= target ? target : null;
}

async function refundLeaderInTx(tx: Tx, state: AuctionState): Promise<void> {
  if (!state.highestBidderId || state.currentPrice <= 0) {
    return;
  }

  await creditUserInTx(
    tx,
    state.highestBidderId,
    state.currentPrice,
    "auction_refund",
    `Reembolso subasta ${state.id}`
  );
}

async function finalizeAuctionWin(
  api: Api,
  state: AuctionState
): Promise<
  | { status: "won"; winnerId: number; winnerLabel: string; price: number; prize: number }
  | { status: "no_bids" }
> {
  const winnerId = state.highestBidderId;
  if (!winnerId) {
    await deleteAuctionState();
    await clearAuctionMessage(api, state);
    await api
      .sendMessage(state.chatId, "La subasta termino sin pujas.", {
        disable_notification: true
      })
      .catch(() => undefined);

    return { status: "no_bids" };
  }

  await sql.begin(async (tx: Tx) => {
    await creditUserInTx(
      tx,
      winnerId,
      state.prizeCoins,
      "auction_prize",
      `Premio subasta ${state.id}`
    );
  });

  const winnerProfile = await getUserPublicProfile(winnerId);
  const winnerLabel = winnerProfile
    ? winnerProfile.username
      ? `@${winnerProfile.username}`
      : winnerProfile.firstName || `user_${winnerProfile.telegramId}`
    : `user_${winnerId}`;
  const winnerMention = `<a href="tg://user?id=${winnerId}">${auctionEscapeHtml(winnerLabel)}</a>`;

  await deleteAuctionState();
  await clearAuctionMessage(api, state);
  await api
    .sendMessage(
      state.chatId,
      [
        "La subasta cerro.",
        "",
        `Ganador: ${winnerMention}`,
        `Precio final: ${state.currentPrice} coins`,
        `Premio entregado: +${state.prizeCoins} coins`
      ].join("\n"),
      {
        disable_notification: true,
        parse_mode: "HTML"
      }
    )
    .catch(() => undefined);

  return {
    status: "won",
    winnerId,
    winnerLabel,
    price: state.currentPrice,
    prize: state.prizeCoins
  };
}

async function cancelAuction(api: Api, state: AuctionState): Promise<{ refunded: boolean }> {
  if (state.highestBidderId) {
    await sql.begin(async (tx: Tx) => {
      await refundLeaderInTx(tx, state);
    });
  }

  await deleteAuctionState();
  await clearAuctionMessage(api, state);

  if (state.highestBidderId) {
    await api
      .sendMessage(
        state.chatId,
        "La subasta anterior fue reemplazada y la puja lider se devolvio.",
        { disable_notification: true }
      )
      .catch(() => undefined);
  }

  return { refunded: Boolean(state.highestBidderId) };
}

export async function clearActiveAuction(api: Api): Promise<{ cleared: boolean; refunded: boolean }> {
  const state = await getAuctionState();
  if (!state) {
    return { cleared: false, refunded: false };
  }

  const result = await cancelAuction(api, state);
  return {
    cleared: true,
    refunded: result.refunded
  };
}

export async function postAuction(api: Api): Promise<{ messageId: number; replaced: boolean; refunded: boolean }> {
  const replacedState = await clearActiveAuction(api);
  const expiresAt = addSeconds(new Date(), appConfig.auctionInitialSeconds);
  const state: AuctionState = {
    id: crypto.randomUUID(),
    chatId: env.groupChatId,
    messageId: 0,
    prizeCoins: AUCTION_PRIZE_COINS,
    currentPrice: AUCTION_BASE_PRICE,
    highestBidderId: null,
    highestBidderUsername: null,
    highestBidderFirstName: null,
    expiresAt: expiresAt.toISOString()
  };

  const message = await api.sendMessage(env.groupChatId, auctionText(state), {
    disable_notification: true,
    parse_mode: "HTML",
    reply_markup: auctionMarkup(state.id)
  });

  const finalState: AuctionState = {
    ...state,
    messageId: message.message_id
  };

  await saveAuctionState(finalState);

  return {
    messageId: message.message_id,
    replaced: replacedState.cleared,
    refunded: replacedState.refunded
  };
}

export function parseAuctionPayload(value: string | undefined): { eventId: string; step: AuctionBidStep } | null {
  if (!value) {
    return null;
  }

  const [eventId, rawStep] = value.split("|");
  const step = resolveBidStep(rawStep);
  if (!eventId || !step) {
    return null;
  }

  return { eventId, step };
}

export async function placeAuctionBid(
  api: Api,
  eventId: string,
  userId: number,
  step: AuctionBidStep
): Promise<
  | { status: "placed"; price: number; balance: number; expiresAt: string; leaderChanged: boolean }
  | { status: "not_found" | "already_leading" | "insufficient_balance" | "too_low" | "busy" }
  | { status: "won"; winnerId: number; winnerLabel: string; price: number; prize: number }
  | { status: "no_bids" }
> {
  const result = await withRedisLock(`auction:${eventId}`, 20, async () => {
    const state = await getAuctionState();
    if (!state || state.id !== eventId) {
      return { status: "not_found" as const };
    }

    if (new Date(state.expiresAt).getTime() <= Date.now()) {
      return finalizeAuctionWin(api, state);
    }

    const currentBidderIsActor = state.highestBidderId === userId;
    const balanceRows = await sql<{ balance: number }[]>`
      select balance
      from users
      where telegram_id = ${userId}
      limit 1
    `;
    const currentBalance = Number(balanceRows[0]?.balance ?? 0);
    const nextPrice = computeNextBidPrice(state, step, currentBalance, currentBidderIsActor);
    if (nextPrice === null) {
      return {
        status: currentBidderIsActor ? "too_low" as const : "insufficient_balance" as const
      };
    }

    if (currentBidderIsActor && nextPrice <= state.currentPrice) {
      return { status: "already_leading" as const };
    }

    const debitAmount = currentBidderIsActor ? nextPrice - state.currentPrice : nextPrice;
    if (debitAmount <= 0) {
      return { status: "too_low" as const };
    }

    const leaderProfile = await getUserPublicProfile(userId);
    if (!leaderProfile) {
      return { status: "not_found" as const };
    }

    const txResult = await sql.begin(async (tx: Tx) => {
      if (!currentBidderIsActor && state.highestBidderId) {
        await refundLeaderInTx(tx, state);
      }

      try {
        const balance = await debitUserInTx(
          tx,
          userId,
          debitAmount,
          "auction_bid",
          `Puja subasta ${state.id} -> ${nextPrice}`
        );
        return { balance };
      } catch (error) {
        if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
          return null;
        }
        throw error;
      }
    });

    if (!txResult) {
      return { status: "insufficient_balance" as const };
    }

    const nextState: AuctionState = {
      ...state,
      currentPrice: nextPrice,
      highestBidderId: leaderProfile.telegramId,
      highestBidderUsername: leaderProfile.username,
      highestBidderFirstName: leaderProfile.firstName,
      expiresAt: addSeconds(new Date(), appConfig.auctionBidResetSeconds).toISOString()
    };

    await saveAuctionState(nextState);
    await updateAuctionMessage(api, nextState);

    return {
      status: "placed" as const,
      price: nextState.currentPrice,
      balance: txResult.balance,
      expiresAt: nextState.expiresAt,
      leaderChanged: !currentBidderIsActor
    };
  });

  return result ?? { status: "busy" };
}

export async function tickAuction(
  api: Api
): Promise<
  | { status: "inactive" }
  | { status: "active"; expiresAt: string; price: number }
  | { status: "won"; winnerId: number; winnerLabel: string; price: number; prize: number }
  | { status: "no_bids" }
> {
  const result = await withRedisLock("auction:tick", 20, async () => {
    const state = await getAuctionState();
    if (!state) {
      return { status: "inactive" as const };
    }

    if (new Date(state.expiresAt).getTime() > Date.now()) {
      return {
        status: "active" as const,
        expiresAt: state.expiresAt,
        price: state.currentPrice
      };
    }

    return finalizeAuctionWin(api, state);
  });

  return result ?? { status: "inactive" };
}
