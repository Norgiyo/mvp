import { env } from "../config";
import { sql } from "../db/postgres";
import type { TelegramProfile } from "../types";

export type UserPublicProfile = {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  specialTitle: string | null;
  balance: number;
};

export async function upsertUser(profile: TelegramProfile): Promise<void> {
  await sql`
    insert into users (telegram_id, username, first_name)
    values (${profile.id}, ${profile.username ?? null}, ${profile.first_name ?? null})
    on conflict (telegram_id) do update
      set username = excluded.username,
          first_name = excluded.first_name,
          updated_at = now()
  `;
}

export async function getBalance(userId: number): Promise<number> {
  const rows = await sql<{ balance: number }[]>`
    select balance
    from users
    where telegram_id = ${userId}
    limit 1
  `;

  return rows[0]?.balance ?? 0;
}

export async function isAdminUser(userId: number): Promise<boolean> {
  if (env.adminTelegramIds.includes(userId)) {
    return true;
  }

  const rows = await sql<{ exists: boolean }[]>`
    select exists(
      select 1
      from users
      where telegram_id = ${userId}
        and role = 'admin'
    ) as exists
  `;

  return Boolean(rows[0]?.exists);
}

export async function getUserPublicProfile(userId: number): Promise<UserPublicProfile | null> {
  const rows = await sql<
    {
      telegram_id: number;
      username: string | null;
      first_name: string | null;
      special_title: string | null;
      balance: number;
    }[]
  >`
    select telegram_id, username, first_name, special_title, balance
    from users
    where telegram_id = ${userId}
    limit 1
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    telegramId: Number(row.telegram_id),
    username: row.username ?? null,
    firstName: row.first_name ?? null,
    specialTitle: row.special_title ?? null,
    balance: Number(row.balance ?? 0)
  };
}

export async function getTopUsersByBalance(limit: number): Promise<UserPublicProfile[]> {
  const rows = await sql<
    {
      telegram_id: number;
      username: string | null;
      first_name: string | null;
      special_title: string | null;
      balance: number;
    }[]
  >`
    select telegram_id, username, first_name, special_title, balance
    from users
    order by balance desc, total_earned desc, telegram_id asc
    limit ${limit}
  `;

  return rows.map((row) => ({
    telegramId: Number(row.telegram_id),
    username: row.username ?? null,
    firstName: row.first_name ?? null,
    specialTitle: row.special_title ?? null,
    balance: Number(row.balance ?? 0)
  }));
}
