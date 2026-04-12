import crypto from "node:crypto";

import type { Api } from "grammy";

import { appConfig, env } from "../config";
import { redis } from "../db/redis";
import { sql } from "../db/postgres";
import type { BirthdayEventState, TelegramProfile } from "../types";
import { creditUserInTx, debitUserInTx } from "./coins";
import { encodeCallback } from "../utils/callbackData";
import { todayKey } from "../utils/time";

const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const BIRTHDAY_GIFT_INSUFFICIENT_BALANCE = "BIRTHDAY_GIFT_INSUFFICIENT_BALANCE";

function birthdayEventKey(eventId: string): string {
  return `birthday:event:${eventId}`;
}

function birthdayPostedKey(day: string, userId: number): string {
  return `birthday:posted:${day}:${userId}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mentionUser(profile: { id: number; username?: string | null; first_name?: string | null }): string {
  const label = profile.username ? `@${profile.username}` : profile.first_name || `user_${profile.id}`;
  return `<a href="tg://user?id=${profile.id}">${escapeHtml(label)}</a>`;
}

function monthDayFromDateKey(day: string): string {
  return day.slice(5, 10);
}

function dayExpiryIso(day: string): string {
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
  return new Date(dayStart + 24 * 60 * 60 * 1000).toISOString();
}

function normalizeBirthdayMd(month: number, day: number): string {
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseBirthdayInput(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (!match) {
    return null;
  }

  const day = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  const maxDay = MONTH_MAX_DAYS[month - 1];
  if (day < 1 || day > maxDay) {
    return null;
  }

  return normalizeBirthdayMd(month, day);
}

export function formatBirthdayMd(value: string): string {
  const [month = "", day = ""] = value.split("-");
  return `${day}/${month}`;
}

export function mentionBirthdayUser(state: {
  birthdayUserId: number;
  birthdayUsername: string | null;
  birthdayFirstName: string | null;
}): string {
  const label = state.birthdayUsername
    ? `@${state.birthdayUsername}`
    : state.birthdayFirstName || `user_${state.birthdayUserId}`;
  return `<a href="tg://user?id=${state.birthdayUserId}">${escapeHtml(label)}</a>`;
}

export async function getUserBirthday(userId: number): Promise<string | null> {
  const rows = await sql<{ birthday_md: string | null }[]>`
    select birthday_md
    from users
    where telegram_id = ${userId}
    limit 1
  `;

  return rows[0]?.birthday_md ?? null;
}

export async function setUserBirthday(userId: number, birthdayMd: string): Promise<void> {
  await sql`
    update users
    set birthday_md = ${birthdayMd},
        updated_at = now()
    where telegram_id = ${userId}
  `;
}

export async function clearUserBirthday(userId: number): Promise<void> {
  await sql`
    update users
    set birthday_md = null,
        updated_at = now()
    where telegram_id = ${userId}
  `;
}

async function getBirthdayProfilesForDay(day: string): Promise<TelegramProfile[]> {
  const rows = await sql<
    {
      telegram_id: number;
      username: string | null;
      first_name: string | null;
    }[]
  >`
    select telegram_id, username, first_name
    from users
    where birthday_md = ${monthDayFromDateKey(day)}
    order by coalesce(first_name, username, telegram_id::text) asc
  `;

  return rows.map((row) => ({
    id: Number(row.telegram_id),
    username: row.username ?? null,
    first_name: row.first_name ?? null
  }));
}

export async function postBirthdayEvent(
  api: Api,
  profile: TelegramProfile,
  day: string = todayKey()
): Promise<{ posted: boolean; messageId?: number }> {
  const posted = await redis.set(birthdayPostedKey(day, profile.id), "1", {
    nx: true,
    ex: appConfig.birthdayEventRetentionTtlSeconds
  });

  if (posted !== "OK") {
    return { posted: false };
  }

  const eventId = crypto.randomUUID();
  const amount = env.birthdayGiftCoins;
  const message = await api.sendMessage(
    env.groupChatId,
    `🎂 Hoy es el cumpleaños de ${mentionUser(profile)}\n\n¿Le mandas un regalo?`,
    {
      disable_notification: true,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `🎁 ${amount} coins`,
              callback_data: encodeCallback("birthday", eventId),
              style: "success"
            }
          ]
        ]
      }
    }
  );

  const state: BirthdayEventState = {
    id: eventId,
    birthdayUserId: profile.id,
    birthdayUsername: profile.username ?? null,
    birthdayFirstName: profile.first_name ?? null,
    amount,
    birthdayDay: day,
    messageId: message.message_id,
    expiresAt: dayExpiryIso(day)
  };

  await redis.set(birthdayEventKey(eventId), state, { ex: appConfig.birthdayEventRetentionTtlSeconds });
  await redis.sadd("birthdays:active", eventId);

  return { posted: true, messageId: message.message_id };
}

export async function postBirthdaysForToday(
  api: Api,
  day: string = todayKey()
): Promise<{ postedCount: number; totalBirthdays: number }> {
  const profiles = await getBirthdayProfilesForDay(day);
  let postedCount = 0;

  for (const profile of profiles) {
    const result = await postBirthdayEvent(api, profile, day);
    if (result.posted) {
      postedCount += 1;
    }
  }

  return {
    postedCount,
    totalBirthdays: profiles.length
  };
}

export async function sendBirthdayGift(
  eventId: string,
  giverId: number
): Promise<
  | {
      status: "ok";
      amount: number;
      giverBalance: number;
      birthdayBalance: number;
      birthdayUserId: number;
      birthdayUsername: string | null;
      birthdayFirstName: string | null;
    }
  | { status: "not_found" | "expired" | "duplicate" | "self_gift_not_allowed" | "insufficient_balance" }
> {
  const state = await redis.get<BirthdayEventState>(birthdayEventKey(eventId));
  if (!state) {
    return { status: "not_found" };
  }

  if (new Date(state.expiresAt).getTime() <= Date.now()) {
    await redis.del(birthdayEventKey(eventId));
    await redis.srem("birthdays:active", eventId);
    return { status: "expired" };
  }

  if (giverId === state.birthdayUserId) {
    return { status: "self_gift_not_allowed" };
  }

  let result:
    | { status: "ok"; giverBalance: number; birthdayBalance: number }
    | { status: "duplicate" };

  try {
    result = await sql.begin(async (tx: any) => {
      const inserted = await tx`
        insert into birthday_gifts (birthday_user_id, giver_user_id, birthday_date)
        values (${state.birthdayUserId}, ${giverId}, ${state.birthdayDay}::date)
        on conflict (birthday_user_id, giver_user_id, birthday_date) do nothing
        returning birthday_user_id
      `;

      if (inserted.length === 0) {
        return { status: "duplicate" as const };
      }

      try {
        const giverBalance = await debitUserInTx(
          tx,
          giverId,
          state.amount,
          "birthday_gift_sent",
          `Regalo de cumpleaños para ${state.birthdayUserId} (${state.birthdayDay})`
        );

        const birthdayBalance = await creditUserInTx(
          tx,
          state.birthdayUserId,
          state.amount,
          "birthday_gift_received",
          `Regalo de cumpleaños de ${giverId} (${state.birthdayDay})`
        );

        return {
          status: "ok" as const,
          giverBalance,
          birthdayBalance
        };
      } catch (error) {
        if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
          throw new Error(BIRTHDAY_GIFT_INSUFFICIENT_BALANCE);
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === BIRTHDAY_GIFT_INSUFFICIENT_BALANCE) {
      return { status: "insufficient_balance" };
    }
    throw error;
  }

  if (result.status !== "ok") {
    return result;
  }

  return {
    status: "ok",
    amount: state.amount,
    giverBalance: result.giverBalance,
    birthdayBalance: result.birthdayBalance,
    birthdayUserId: state.birthdayUserId,
    birthdayUsername: state.birthdayUsername,
    birthdayFirstName: state.birthdayFirstName
  };
}
