import { sql } from "../db/postgres";
import { debitUserInTx } from "./coins";

const DEFAULT_FONDO_CUP_RATE = 515;

function parseUsdAmount(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function formatCupAmountFromUsd(amountUsd: number, rate: number): string {
  const amountCup = Math.floor(amountUsd * rate * 100) / 100;
  return `${new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amountCup)} CUP`;
}

function usdFromCup(amountCup: number, rate: number): number {
  return amountCup / rate;
}

function parseRateValue(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

async function getFondoCupRateInTx(tx: any): Promise<number> {
  const rows = await tx<{ value: string | null }[]>`
    select value
    from public_stats
    where key = 'fondo_rate'
    limit 1
  `;

  return parseRateValue(rows[0]?.value) ?? DEFAULT_FONDO_CUP_RATE;
}

async function addFondoUsdInTx(tx: any, amountUsd: number): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return;
  }

  const normalized = amountUsd.toFixed(6);
  await tx`
    insert into public_stats (key, value, updated_at)
    values ('fondo', ${normalized}, now())
    on conflict (key) do update
    set
      value = (
        coalesce(nullif(public_stats.value, ''), '0')::numeric
        + ${normalized}::numeric
      )::text,
      updated_at = now()
  `;
}

export async function getFondoValue(): Promise<string> {
  const [valueRows, rate] = await Promise.all([
    sql<{ value: string | null }[]>`
      select value
      from public_stats
      where key = 'fondo'
      limit 1
    `,
    getFondoCupRate()
  ]);

  const amountUsd = parseUsdAmount(valueRows[0]?.value) ?? 0;
  return formatCupAmountFromUsd(amountUsd, rate);
}

export async function getFondoCupRate(): Promise<number> {
  const rows = await sql<{ value: string | null }[]>`
    select value
    from public_stats
    where key = 'fondo_rate'
    limit 1
  `;

  return parseRateValue(rows[0]?.value) ?? DEFAULT_FONDO_CUP_RATE;
}

export async function setFondoCupRate(rate: number): Promise<number> {
  if (!Number.isInteger(rate) || rate <= 0) {
    throw new Error("INVALID_FONDO_RATE");
  }

  await sql`
    insert into public_stats (key, value, updated_at)
    values ('fondo_rate', ${String(rate)}, now())
    on conflict (key) do update
      set value = excluded.value,
          updated_at = now()
  `;

  return rate;
}

export async function adjustFondoCupRate(delta: number): Promise<number> {
  return sql.begin(async (tx: any) => {
    const currentRate = await getFondoCupRateInTx(tx);
    const nextRate = Math.max(1, currentRate + delta);

    await tx`
      insert into public_stats (key, value, updated_at)
      values ('fondo_rate', ${String(nextRate)}, now())
      on conflict (key) do update
        set value = excluded.value,
            updated_at = now()
    `;

    return nextRate;
  });
}

export async function getFondoSummary(): Promise<{
  amountUsd: number;
  rate: number;
  formattedValue: string;
}> {
  const [valueRows, rate] = await Promise.all([
    sql<{ value: string | null }[]>`
      select value
      from public_stats
      where key = 'fondo'
      limit 1
    `,
    getFondoCupRate()
  ]);

  const amountUsd = parseUsdAmount(valueRows[0]?.value) ?? 0;
  return {
    amountUsd,
    rate,
    formattedValue: formatCupAmountFromUsd(amountUsd, rate)
  };
}

export async function clearFondoValue(): Promise<string> {
  const amountUsd = await sql.begin(async (tx: any) => {
    const rows = await tx<{ value: string | null }[]>`
      select value
      from public_stats
      where key = 'fondo'
      for update
    `;

    const currentAmountUsd = parseUsdAmount(rows[0]?.value) ?? 0;

    await tx`
      insert into public_stats (key, value, updated_at)
      values ('fondo', '0', now())
      on conflict (key) do update
        set value = '0',
            updated_at = now()
    `;

    return currentAmountUsd;
  });

  return formatCupAmountFromUsd(amountUsd, await getFondoCupRate());
}

export async function addFondoRevenueInTx(
  tx: any,
  estimatedPrice: string | null | undefined
): Promise<void> {
  const amount = parseUsdAmount(estimatedPrice);
  if (amount === null || amount <= 0) {
    return;
  }

  await addFondoUsdInTx(tx, amount);
}

export async function donateCoinsToFondo(
  userId: number,
  amountCoins: number
): Promise<
  | { status: "ok"; balance: number; fondo: string }
  | { status: "invalid_amount" | "insufficient_balance" }
> {
  if (!Number.isInteger(amountCoins) || amountCoins <= 0) {
    return { status: "invalid_amount" };
  }

  try {
    const result = await sql.begin(async (tx: any) => {
      const balance = await debitUserInTx(
        tx,
        userId,
        amountCoins,
        "fondo_donation",
        `Donacion al Fondo: ${amountCoins} coins`
      );

      const rate = await getFondoCupRateInTx(tx);
      await addFondoUsdInTx(tx, usdFromCup(amountCoins, rate));
      return { balance };
    });

    return {
      status: "ok",
      balance: result.balance,
      fondo: await getFondoValue()
    };
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      return { status: "insufficient_balance" };
    }
    throw error;
  }
}
