import type { Api } from "grammy";

import { env } from "../config";
import { sql } from "../db/postgres";
import { creditUserInTx } from "./coins";
import { getTopUsersByBalance, type UserPublicProfile } from "./users";

const TROPHY_EMOJI = String.fromCodePoint(0x1F3C6);
const COIN_EMOJI = String.fromCodePoint(0x1FA99);
const CHECK_EMOJI = String.fromCodePoint(0x2705);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function weekKeyUtc(date = new Date()): string {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function formatUserLabel(user: UserPublicProfile): string {
  if (user.username) {
    return `@${user.username}`;
  }
  if (user.firstName) {
    return user.firstName;
  }
  return `user_${user.telegramId}`;
}

function formatUserMention(user: UserPublicProfile): string {
  return `<a href="tg://user?id=${user.telegramId}">${escapeHtml(formatUserLabel(user))}</a>`;
}

async function applyWeeklyWinnerBonus(
  weekKey: string,
  winner: UserPublicProfile
): Promise<{ bonusGiven: boolean; winnerBalance: number }> {
  return sql.begin(async (tx: any) => {
    const key = `leaderboard:weekly:bonus:${weekKey}`;
    const claimed = await tx<{ key: string }[]>`
      insert into public_stats (key, value, updated_at)
      values (${key}, ${String(winner.telegramId)}, now())
      on conflict (key) do nothing
      returning key
    `;

    if (claimed.length === 0) {
      return { bonusGiven: false, winnerBalance: winner.balance };
    }

    const winnerBalance = await creditUserInTx(
      tx,
      winner.telegramId,
      env.weeklyLeaderboardBonusCoins,
      "weekly_leaderboard_bonus",
      `Bonus leaderboard semanal ${weekKey}`
    );

    return { bonusGiven: true, winnerBalance };
  });
}

export async function postWeeklyLeaderboard(api: Api): Promise<{
  posted: boolean;
  weekKey: string;
  bonusGiven: boolean;
  winnerId: number | null;
}> {
  const key = weekKeyUtc();
  const users = await getTopUsersByBalance(10);
  if (users.length === 0) {
    await api.sendMessage(env.groupChatId, `${TROPHY_EMOJI} Leaderboard semanal (${key})\n\nAun no hay participantes.`, {
      disable_notification: true
    });
    return { posted: true, weekKey: key, bonusGiven: false, winnerId: null };
  }

  const winner = users[0];
  const { bonusGiven } = await applyWeeklyWinnerBonus(key, winner);

  const lines = users.map((user, index) => {
    return `${index + 1}. ${formatUserMention(user)} - ${user.balance} ${COIN_EMOJI}`;
  });

  const bonusLine = bonusGiven
    ? `\n\n${TROPHY_EMOJI} Bonus semanal: ${formatUserMention(winner)} gana +${env.weeklyLeaderboardBonusCoins} ${COIN_EMOJI}`
    : `\n\n${CHECK_EMOJI} Bonus semanal ya entregado para esta semana.`;

  await api.sendMessage(env.groupChatId, `${TROPHY_EMOJI} Leaderboard semanal (${key})\n\n${lines.join("\n")}${bonusLine}`, {
    disable_notification: true,
    parse_mode: "HTML"
  });

  return { posted: true, weekKey: key, bonusGiven, winnerId: winner.telegramId };
}
