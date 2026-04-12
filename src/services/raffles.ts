import crypto from "node:crypto";

import type { Api } from "grammy";

import { env } from "../config";
import { redis } from "../db/redis";
import { sql } from "../db/postgres";
import { creditUserInTx, debitUserInTx } from "./coins";
import { getUserPublicProfile } from "./users";
import { encodeCallback } from "../utils/callbackData";

type RaffleEventState = {
  messageId: number;
  expiresAt: string;
};

export const RAFFLE_DEFAULT_ENTRY_COST = 10;
export const RAFFLE_MAX_ENTRIES_PER_USER = 10;

export type ClosedRaffleResult = {
  status: "closed";
  title: string;
  winnerId: number | null;
  prizeAmount: number;
  closedMessageId: number | null;
};

export type CloseRaffleResult = ClosedRaffleResult | { status: "not_found" | "already_closed" };

function raffleEventKey(raffleId: string): string {
  return `raffle:event:${raffleId}`;
}

function getRaffleEventTtlSeconds(endsAt: string): number {
  const endsAtMs = new Date(endsAt).getTime();
  const remainingSeconds = Math.ceil((endsAtMs - Date.now()) / 1000);
  return Math.max(60 * 60, remainingSeconds + 24 * 60 * 60);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mentionFromProfile(profile: {
  telegramId: number;
  username: string | null;
  firstName: string | null;
}): string {
  const label = profile.username ? `@${profile.username}` : profile.firstName || `user_${profile.telegramId}`;
  return `<a href="tg://user?id=${profile.telegramId}">${escapeHtml(label)}</a>`;
}

export async function createRaffle(
  api: Api,
  input: {
    title: string;
    prizeAmount: number;
    entryCost: number;
    endsAt: string;
  }
): Promise<{ id: string; messageId: number }> {
  const raffleId = crypto.randomUUID();

  await sql`
    insert into raffles (id, title, prize_amount, entry_cost, status, ends_at)
    values (
      ${raffleId},
      ${input.title},
      ${input.prizeAmount},
      ${input.entryCost},
      'active',
      ${input.endsAt}
    )
  `;

  const messageText = [
    "Sorteo activo",
    "",
    input.title,
    `Premio: ${input.prizeAmount} coins`,
    `Costo: ${input.entryCost} coins por entrada`,
    `Maximo: ${RAFFLE_MAX_ENTRIES_PER_USER} entradas por usuario`,
    `Cierra: ${new Date(input.endsAt).toLocaleString("es-AR")}`
  ].join("\n");

  const message = await api.sendMessage(env.groupChatId, messageText, {
    disable_notification: true,
    reply_markup: {
        inline_keyboard: [
          [
            {
              text: `Comprar -${input.entryCost} 🪙`,
              callback_data: encodeCallback("raffle", raffleId),
              style: "danger"
            }
          ]
        ]
    }
  });

  const eventState: RaffleEventState = {
    messageId: message.message_id,
    expiresAt: input.endsAt
  };
  try {
    await redis.set(raffleEventKey(raffleId), eventState, {
      ex: getRaffleEventTtlSeconds(input.endsAt)
    });
    await redis.sadd("raffles:active", raffleId);
  } catch (error) {
    console.error("raffle_event_state_store_failed", {
      raffleId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return { id: raffleId, messageId: message.message_id };
}

export async function joinRaffle(
  raffleId: string,
  userId: number
): Promise<
  | { status: "ok"; balance: number; entryCost: number; entriesUsed: number }
  | { status: "not_found" | "closed" | "entry_limit_reached" | "insufficient_balance" }
> {
  return sql.begin(async (tx: any) => {
    const raffles = await tx<
      {
        title: string;
        entry_cost: number;
        status: string;
        ends_at: string;
      }[]
    >`
      select title, entry_cost, status, ends_at
      from raffles
      where id = ${raffleId}
      for update
    `;

    const raffle = raffles[0];
    if (!raffle) {
      return { status: "not_found" as const };
    }

    if (raffle.status !== "active" || new Date(raffle.ends_at).getTime() <= Date.now()) {
      return { status: "closed" as const };
    }

    const entryCountRows = await tx<{ entry_count: number | string }[]>`
      select count(*)::int as entry_count
      from raffle_entries
      where raffle_id = ${raffleId}
        and user_id = ${userId}
    `;

    const entriesUsed = Number(entryCountRows[0]?.entry_count ?? 0);
    if (entriesUsed >= RAFFLE_MAX_ENTRIES_PER_USER) {
      return { status: "entry_limit_reached" as const };
    }

    await tx`
      insert into raffle_entries (raffle_id, user_id)
      values (${raffleId}, ${userId})
    `;

    try {
      const balance = await debitUserInTx(
        tx,
        userId,
        raffle.entry_cost,
        "raffle_entry",
        `Entrada sorteo ${raffle.title}`
      );

      return {
        status: "ok" as const,
        balance,
        entryCost: raffle.entry_cost,
        entriesUsed: entriesUsed + 1
      };
    } catch (error) {
      if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
        throw error;
      }
      throw error;
    }
  }).catch((error) => {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      return { status: "insufficient_balance" as const };
    }
    throw error;
  });
}

export async function closeRaffle(
  raffleId: string
): Promise<CloseRaffleResult> {
  const result = await sql.begin(async (tx: any) => {
    const raffles = await tx<
      {
        title: string;
        prize_amount: number;
        status: string;
      }[]
    >`
      select title, prize_amount, status
      from raffles
      where id = ${raffleId}
      for update
    `;

    const raffle = raffles[0];
    if (!raffle) {
      return { status: "not_found" as const };
    }

    if (raffle.status !== "active") {
      return { status: "already_closed" as const };
    }

    const winners = await tx<{ user_id: number }[]>`
      select user_id
      from raffle_entries
      where raffle_id = ${raffleId}
      order by random()
      limit 1
    `;

    const winnerId = winners[0]?.user_id ?? null;

    await tx`
      update raffles
      set status = 'closed'
      where id = ${raffleId}
    `;

    if (winnerId) {
      await creditUserInTx(
        tx,
        winnerId,
        raffle.prize_amount,
        "raffle_prize",
        `Premio sorteo ${raffle.title}`
      );
    }

    return {
      status: "closed" as const,
      title: raffle.title,
      winnerId,
      prizeAmount: raffle.prize_amount
    };
  });

  if (result.status !== "closed") {
    return result;
  }

  let closedMessageId: number | null = null;
  try {
    const eventState = await redis.get<RaffleEventState>(raffleEventKey(raffleId));
    closedMessageId = eventState?.messageId ?? null;
    await redis.del(raffleEventKey(raffleId));
    await redis.srem("raffles:active", raffleId);
  } catch (error) {
    console.error("raffle_event_state_cleanup_failed", {
      raffleId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return {
    ...result,
    closedMessageId
  };
}

export async function getLatestActiveRaffleId(): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select id
    from raffles
    where status = 'active'
    order by created_at desc
    limit 1
  `;

  return rows[0]?.id ?? null;
}

export async function announceClosedRaffle(api: Api, result: ClosedRaffleResult): Promise<void> {
  const safeTitle = escapeHtml(result.title);
  let message = `Sorteo cerrado\n\n${safeTitle}\nNo hubo participantes esta vez.`;
  if (result.winnerId !== null) {
    const winnerProfile = await getUserPublicProfile(result.winnerId);
    message = winnerProfile
      ? `Sorteo cerrado\n\n${safeTitle}\nGanador: ${mentionFromProfile(winnerProfile)}\nPremio: ${result.prizeAmount}`
      : `Sorteo cerrado\n\n${safeTitle}\nGanador: <a href="tg://user?id=${result.winnerId}">usuario</a>\nPremio: ${result.prizeAmount}`;
  }

  await api.sendMessage(env.groupChatId, message, {
    disable_notification: true,
    parse_mode: "HTML"
  });

  if (typeof result.closedMessageId === "number") {
    await api.deleteMessage(env.groupChatId, result.closedMessageId).catch(() => undefined);
  }
}

export async function closeRaffleAndAnnounce(api: Api, raffleId: string): Promise<CloseRaffleResult> {
  const result = await closeRaffle(raffleId);
  if (result.status === "closed") {
    await announceClosedRaffle(api, result);
  }

  return result;
}

export async function createNextRaffle(
  api: Api,
  input: {
    title: string;
    prizeAmount: number;
    entryCost: number;
    endsAt: string;
  }
): Promise<{ raffle: { id: string; messageId: number }; replacedRaffleId: string | null }> {
  const replacedRaffleId = await getLatestActiveRaffleId();
  if (replacedRaffleId) {
    const closeResult = await closeRaffleAndAnnounce(api, replacedRaffleId);
    if (closeResult.status !== "closed" && closeResult.status !== "already_closed" && closeResult.status !== "not_found") {
      throw new Error("ACTIVE_RAFFLE_CLOSE_FAILED");
    }
  }

  const raffle = await createRaffle(api, input);
  return { raffle, replacedRaffleId };
}
