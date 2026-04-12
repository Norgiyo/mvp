import { env } from "../config";
import { sql } from "../db/postgres";
import type { RewardType } from "../types";

type Tx = any;

function parseDateKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function diffDaysUtc(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

function streakMultiplier(streakDays: number): number {
  if (streakDays >= 8) {
    return 2;
  }
  if (streakDays >= 4) {
    return 1.5;
  }
  return 1;
}

async function creditUserInTx(
  tx: Tx,
  userId: number,
  amount: number,
  type: RewardType,
  description: string
): Promise<number> {
  const updated = await tx<{ balance: number }[]>`
    update users
    set balance = balance + ${amount},
        total_earned = total_earned + ${amount},
        updated_at = now()
    where telegram_id = ${userId}
    returning balance
  `;

  if (!updated[0]) {
    throw new Error(`User ${userId} not found`);
  }

  await tx`
    insert into transactions (user_id, type, amount, description)
    values (${userId}, ${type}, ${amount}, ${description})
  `;

  return updated[0].balance;
}

export async function debitUserInTx(
  tx: Tx,
  userId: number,
  amount: number,
  type: RewardType,
  description: string
): Promise<number> {
  const rows = await tx<{ balance: number }[]>`
    select balance
    from users
    where telegram_id = ${userId}
    for update
  `;

  const currentBalance = rows[0]?.balance;
  if (typeof currentBalance !== "number") {
    throw new Error(`User ${userId} not found`);
  }

  if (currentBalance < amount) {
    throw new Error("INSUFFICIENT_BALANCE");
  }

  const nextBalance = currentBalance - amount;
  await tx`
    update users
    set balance = ${nextBalance},
        updated_at = now()
    where telegram_id = ${userId}
  `;

  await tx`
    insert into transactions (user_id, type, amount, description)
    values (${userId}, ${type}, ${-amount}, ${description})
  `;

  return nextBalance;
}

export async function getTodayCountByType(userId: number, type: RewardType): Promise<number> {
  const rows = await sql<{ total: number | null }[]>`
    select count(*)::int as total
    from transactions
    where user_id = ${userId}
      and type = ${type}
      and created_at >= date_trunc('day', now())
  `;

  return Number(rows[0]?.total ?? 0);
}

export async function claimDailyReward(
  userId: number,
  claimDate: string
): Promise<
  | { status: "ok"; balance: number; rewardAmount: number; streakDays: number; multiplier: number }
  | { status: "duplicate" }
> {
  const claimDateUtc = parseDateKey(claimDate);
  if (!claimDateUtc) {
    return { status: "duplicate" };
  }

  return sql.begin(async (tx: Tx) => {
    const inserted = await tx`
      insert into daily_claims (user_id, claim_date)
      values (${userId}, ${claimDate}::date)
      on conflict (user_id, claim_date) do nothing
      returning user_id
    `;

    if (inserted.length === 0) {
      return { status: "duplicate" as const };
    }

    const claims = await tx<{ claim_date: string }[]>`
      select claim_date::text as claim_date
      from daily_claims
      where user_id = ${userId}
        and claim_date <= ${claimDate}::date
      order by claim_date desc
      limit 35
    `;

    let streakDays = 0;
    let cursor = claimDateUtc;
    for (const row of claims) {
      const claimedDate = parseDateKey(row.claim_date.slice(0, 10));
      if (!claimedDate) {
        continue;
      }

      const diff = diffDaysUtc(cursor, claimedDate);
      if (diff === 0) {
        streakDays += 1;
        cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
        continue;
      }
      break;
    }

    const multiplier = streakMultiplier(streakDays);
    const rewardAmount = Math.max(1, Math.floor(env.dailyRewardCoins * multiplier));

    const balance = await creditUserInTx(
      tx,
      userId,
      rewardAmount,
      "daily_reward",
      `Daily reward ${claimDate} (racha ${streakDays} x${multiplier})`
    );

    return { status: "ok" as const, balance, rewardAmount, streakDays, multiplier };
  });
}

export async function claimLuckyDrop(
  dropId: string,
  userId: number,
  amount: number
): Promise<
  | { status: "ok"; balance: number }
  | { status: "duplicate" }
> {
  return sql.begin(async (tx: Tx) => {
    const inserted = await tx`
      insert into drop_claims (drop_id, user_id)
      values (${dropId}, ${userId})
      on conflict (drop_id, user_id) do nothing
      returning drop_id
    `;

    if (inserted.length === 0) {
      return { status: "duplicate" as const };
    }

    const balance = await creditUserInTx(
      tx,
      userId,
      amount,
      "lucky_drop",
      `Lucky drop ${dropId}`
    );

    return { status: "ok" as const, balance };
  });
}

export { creditUserInTx };
