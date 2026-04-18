import crypto from "node:crypto";

import type { Api } from "grammy";

import { appConfig, env } from "../config";
import { redis } from "../db/redis";
import { sql } from "../db/postgres";
import { acquireCooldown, logFraud, withRedisLock } from "./antiAbuse";
import { creditUserInTx, getTodayCountByType } from "./coins";
import { addFondoRevenueInTx } from "./fondo";
import type {
  AdAttemptState,
  AdAttemptStatus,
  AdAttemptUiState,
  AdEventState,
  MonetagPostbackPayload
} from "../types";
import { addSeconds, isExpired } from "../utils/time";

type AdClaimRow = {
  token: string;
  event_id: string;
  user_id: number;
  ymid: string;
  sdk_zone_id: string;
  reward_amount: number;
  request_var: string;
  status: AdAttemptStatus;
  frontend_resolved_at: string | null;
  frontend_failed_at: string | null;
  frontend_error: string | null;
  postback_received_at: string | null;
  rewarded_at: string | null;
  last_event_type: string | null;
  last_reward_event_type: string | null;
  expires_at: string;
  created_at: string;
};

type AdRewardStatsRow = {
  total: number;
  last_rewarded_at: string | null;
};

function adEventKey(eventId: string): string {
  return `ad:event:${eventId}`;
}

function mapAttempt(row: AdClaimRow): AdAttemptState {
  return {
    token: row.token,
    eventId: row.event_id,
    userId: Number(row.user_id),
    ymid: row.ymid,
    zoneId: row.sdk_zone_id,
    rewardAmount: Number(row.reward_amount),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    rewardedAt: row.rewarded_at,
    postbackReceivedAt: row.postback_received_at,
    lastRewardEventType: row.last_reward_event_type,
    lastEventType: row.last_event_type
  };
}

function isConfiguredMonetagZone(zoneId: string): boolean {
  return env.monetagMainZoneIds.includes(zoneId);
}

function adThrottleSecondsRemaining(stats: AdRewardStatsRow): number {
  const total = Number(stats.total ?? 0);
  if (total < env.adThrottleAfterCount) {
    return 0;
  }

  if (!stats.last_rewarded_at) {
    return 0;
  }

  const elapsedSeconds = Math.floor((Date.now() - new Date(stats.last_rewarded_at).getTime()) / 1000);
  const remaining = env.adThrottleCooldownSeconds - elapsedSeconds;
  return remaining > 0 ? remaining : 0;
}

export async function getNextMonetagZoneId(): Promise<string> {
  const cursor = await redis.incr("monetag:zone:rr");
  const index = (cursor - 1) % env.monetagMainZoneIds.length;
  return env.monetagMainZoneIds[index]!;
}

function buildAdMiniAppLink(eventId: string): string {
  const url = new URL(`https://t.me/${env.botUsername}`);
  url.searchParams.set("startapp", eventId);
  url.searchParams.set("mode", "compact");
  return url.toString();
}

export async function postAdEvent(
  api: Api,
  options: { force?: boolean } = {}
): Promise<AdEventState | null> {
  return withRedisLock("event:ad", 15, async () => {
    const lastPostedKey = "event:ad:last_posted";
    if (!options.force) {
      const existingCooldown = await redis.ttl(lastPostedKey);
      if (typeof existingCooldown === "number" && existingCooldown > 0) {
        return null;
      }
    }

    const eventId = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = addSeconds(createdAt, appConfig.adEventTtlSeconds);
    const miniAppUrl = buildAdMiniAppLink(eventId);

    const message = await api.sendMessage(
      env.groupChatId,
      `📺 Anuncio disponible\n\nAbrí la Mini App y mirá un rewarded para ganar +${env.adRewardCoins} 🪙`,
      {
        disable_notification: true,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `Ver anuncio +${env.adRewardCoins}`,
                url: miniAppUrl,
                style: "primary"
              }
            ]
          ]
        }
      }
    );
    const state: AdEventState = {
      id: eventId,
      reward: env.adRewardCoins,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      messageId: message.message_id
    };

    await redis.set(adEventKey(eventId), state, { ex: appConfig.adEventTtlSeconds });
    await redis.sadd("ads:active", eventId);
    await redis.set(lastPostedKey, eventId, { ex: env.adEventCooldownSeconds });

    return state;
  });
}

export async function getAdEvent(eventId: string): Promise<AdEventState | null> {
  const state = await redis.get<AdEventState>(adEventKey(eventId));
  if (!state || isExpired(state.expiresAt)) {
    return null;
  }
  return state;
}

export async function createAdAttempt(params: {
  eventId: string;
  userId: number;
  zoneId: string;
  requestVar?: string;
}): Promise<
  | { status: "ok"; attempt: AdAttemptState }
  | { status: "expired" | "limit_reached" | "cooldown" | "invalid_zone" }
  | { status: "throttled"; retryAfterSeconds: number }
> {
  const event = await getAdEvent(params.eventId);
  if (!event) {
    return { status: "expired" };
  }

  if (!isConfiguredMonetagZone(params.zoneId)) {
    return { status: "invalid_zone" };
  }

  const reusableRows = await sql<AdClaimRow[]>`
    select
      token,
      event_id,
      user_id,
      ymid,
      sdk_zone_id,
      reward_amount,
      request_var,
      status,
      frontend_resolved_at,
      frontend_failed_at,
      frontend_error,
      postback_received_at,
      rewarded_at,
      last_event_type,
      last_reward_event_type,
      expires_at,
      created_at
    from ad_claims
    where event_id = ${params.eventId}
      and user_id = ${params.userId}
      and status = 'pending'
      and expires_at > now()
    order by created_at desc
    limit 1
  `;

  const reusableAttempt = reusableRows[0];
  if (reusableAttempt) {
    return {
      status: "ok",
      attempt: mapAttempt(reusableAttempt)
    };
  }

  const dailyCount = await getTodayCountByType(params.userId, "ad_reward");
  if (dailyCount >= env.adDailyLimit) {
    return { status: "limit_reached" };
  }

  const rewardStats = await sql<AdRewardStatsRow[]>`
    select
      count(*)::int as total,
      max(created_at) as last_rewarded_at
    from transactions
    where user_id = ${params.userId}
      and type = 'ad_reward'
      and created_at >= date_trunc('day', now())
  `;

  const retryAfterSeconds = adThrottleSecondsRemaining(
    rewardStats[0] ?? { total: 0, last_rewarded_at: null }
  );
  if (retryAfterSeconds > 0) {
    return { status: "throttled", retryAfterSeconds };
  }

  const cooldown = await acquireCooldown("ad_attempt", params.userId, 2);
  if (!cooldown) {
    return { status: "cooldown" };
  }

  const token = crypto.randomUUID();
  const ymid = crypto.randomUUID();
  const expiresAt = addSeconds(new Date(), appConfig.adClaimTtlSeconds).toISOString();
  const requestVar = params.requestVar ?? env.monetagRequestVar;

  const rows = await sql<AdClaimRow[]>`
    insert into ad_claims (
      token,
      event_id,
      user_id,
      ymid,
      sdk_zone_id,
      reward_amount,
      request_var,
      status,
      expires_at
    )
    values (
      ${token},
      ${params.eventId},
      ${params.userId},
      ${ymid},
      ${params.zoneId},
      ${env.adRewardCoins},
      ${requestVar},
      'pending',
      ${expiresAt}
    )
    returning
      token,
      event_id,
      user_id,
      ymid,
      sdk_zone_id,
      reward_amount,
      request_var,
      status,
      frontend_resolved_at,
      frontend_failed_at,
      frontend_error,
      postback_received_at,
      rewarded_at,
      last_event_type,
      last_reward_event_type,
      expires_at,
      created_at
  `;

  return {
    status: "ok",
    attempt: mapAttempt(rows[0])
  };
}

export async function getAdAttemptStatus(params: {
  token: string;
  userId: number;
  clientState?: AdAttemptUiState;
  clientError?: string | null;
}): Promise<
  | { status: "ok"; attempt: AdAttemptState; balance: number }
  | { status: "not_found" | "invalid_user" }
> {
  return sql.begin(async (tx: any) => {
    const rows = await tx<AdClaimRow[]>`
      select
        token,
        event_id,
        user_id,
        ymid,
        sdk_zone_id,
        reward_amount,
        request_var,
        status,
        frontend_resolved_at,
        frontend_failed_at,
        frontend_error,
        postback_received_at,
        rewarded_at,
        last_event_type,
        last_reward_event_type,
        expires_at,
        created_at
      from ad_claims
      where token = ${params.token}
      for update
    `;

    const row = rows[0];
    if (!row) {
      return { status: "not_found" as const };
    }

    if (Number(row.user_id) !== params.userId) {
      return { status: "invalid_user" as const };
    }

    const nextStatus =
      row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now()
        ? "expired"
        : row.status;

    const updatedRows = await tx<AdClaimRow[]>`
      update ad_claims
      set
        status = ${nextStatus},
        frontend_resolved_at = case
          when ${params.clientState === "resolved"} then now()
          else frontend_resolved_at
        end,
        frontend_failed_at = case
          when ${params.clientState === "failed"} then now()
          else frontend_failed_at
        end,
        frontend_error = case
          when ${params.clientState === "failed"} then ${params.clientError ?? null}
          else frontend_error
        end
      where token = ${params.token}
      returning
        token,
        event_id,
        user_id,
        ymid,
        sdk_zone_id,
        reward_amount,
        request_var,
        status,
        frontend_resolved_at,
        frontend_failed_at,
        frontend_error,
        postback_received_at,
        rewarded_at,
        last_event_type,
        last_reward_event_type,
        expires_at,
        created_at
    `;

    const updated = updatedRows[0];
    const balanceRows = await tx<{ balance: number }[]>`
      select balance
      from users
      where telegram_id = ${params.userId}
      limit 1
    `;

    return {
      status: "ok" as const,
      attempt: mapAttempt(updated),
      balance: Number(balanceRows[0]?.balance ?? 0)
    };
  });
}

export async function processMonetagPostback(
  payload: MonetagPostbackPayload
): Promise<
  | { status: "processed"; rewarded: boolean; userId?: number }
  | { status: "ignored"; reason: string }
> {
  if (!payload.ymid) {
    return { status: "ignored", reason: "missing_ymid" };
  }

  const result = await sql.begin(async (tx: any) => {
    const rows = await tx<AdClaimRow[]>`
      select
        token,
        event_id,
        user_id,
        ymid,
        sdk_zone_id,
        reward_amount,
        request_var,
        status,
        frontend_resolved_at,
        frontend_failed_at,
        frontend_error,
        postback_received_at,
        rewarded_at,
        last_event_type,
        last_reward_event_type,
        expires_at,
        created_at
      from ad_claims
      where ymid = ${payload.ymid}
      for update
    `;

    const row = rows[0];
    if (!row) {
      return { status: "ignored" as const, reason: "unknown_ymid" };
    }

    const zoneMatches = payload.zone_id === row.sdk_zone_id;
    const requestVarMatches = !payload.request_var || payload.request_var === row.request_var;
    const telegramMatches =
      !payload.telegram_id || Number(payload.telegram_id) === Number(row.user_id);

    if (!zoneMatches || !requestVarMatches || !telegramMatches) {
      await tx`
        update ad_claims
        set
          postback_received_at = now(),
          last_event_type = ${payload.event_type ?? null},
          last_reward_event_type = ${payload.reward_event_type ?? null},
          last_estimated_price = ${payload.estimated_price ?? null},
          last_zone_id = ${payload.zone_id ?? null},
          last_sub_zone_id = ${payload.sub_zone_id ?? null},
          last_telegram_id = ${payload.telegram_id ?? null},
          last_postback = ${JSON.stringify(payload)}::jsonb
        where ymid = ${payload.ymid}
      `;

      return { status: "ignored" as const, reason: "postback_mismatch", userId: row.user_id };
    }

    const isExpiredNow =
      row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now();

    if (row.rewarded_at) {
      await tx`
        update ad_claims
        set
          status = 'rewarded',
          postback_received_at = now(),
          last_event_type = ${payload.event_type ?? null},
          last_reward_event_type = ${payload.reward_event_type ?? null},
          last_estimated_price = ${payload.estimated_price ?? null},
          last_zone_id = ${payload.zone_id ?? null},
          last_sub_zone_id = ${payload.sub_zone_id ?? null},
          last_telegram_id = ${payload.telegram_id ?? null},
          last_postback = ${JSON.stringify(payload)}::jsonb
        where ymid = ${payload.ymid}
      `;

      return { status: "processed" as const, rewarded: false };
    }

    if (payload.reward_event_type !== "valued") {
      const nextStatus = isExpiredNow ? "expired" : "not_valued";
      await tx`
        update ad_claims
        set
          status = ${nextStatus},
          postback_received_at = now(),
          last_event_type = ${payload.event_type ?? null},
          last_reward_event_type = ${payload.reward_event_type ?? null},
          last_estimated_price = ${payload.estimated_price ?? null},
          last_zone_id = ${payload.zone_id ?? null},
          last_sub_zone_id = ${payload.sub_zone_id ?? null},
          last_telegram_id = ${payload.telegram_id ?? null},
          last_postback = ${JSON.stringify(payload)}::jsonb
        where ymid = ${payload.ymid}
      `;

      return { status: "processed" as const, rewarded: false };
    }

    if (isExpiredNow) {
      await tx`
        update ad_claims
        set
          status = 'expired',
          postback_received_at = now(),
          last_event_type = ${payload.event_type ?? null},
          last_reward_event_type = ${payload.reward_event_type ?? null},
          last_estimated_price = ${payload.estimated_price ?? null},
          last_zone_id = ${payload.zone_id ?? null},
          last_sub_zone_id = ${payload.sub_zone_id ?? null},
          last_telegram_id = ${payload.telegram_id ?? null},
          last_postback = ${JSON.stringify(payload)}::jsonb
        where ymid = ${payload.ymid}
      `;

      return { status: "processed" as const, rewarded: false };
    }

    const dailyRows = await tx<{ total: number }[]>`
      select count(*)::int as total
      from transactions
      where user_id = ${row.user_id}
        and type = 'ad_reward'
        and created_at >= date_trunc('day', now())
    `;

    const totalToday = Number(dailyRows[0]?.total ?? 0);
    if (totalToday >= env.adDailyLimit) {
      await tx`
        update ad_claims
        set
          status = 'limit_reached',
          postback_received_at = now(),
          last_event_type = ${payload.event_type ?? null},
          last_reward_event_type = ${payload.reward_event_type ?? null},
          last_estimated_price = ${payload.estimated_price ?? null},
          last_zone_id = ${payload.zone_id ?? null},
          last_sub_zone_id = ${payload.sub_zone_id ?? null},
          last_telegram_id = ${payload.telegram_id ?? null},
          last_postback = ${JSON.stringify(payload)}::jsonb
        where ymid = ${payload.ymid}
      `;

      return { status: "processed" as const, rewarded: false };
    }

    const rewardStats = await tx<AdRewardStatsRow[]>`
      select
        count(*)::int as total,
        max(created_at) as last_rewarded_at
      from transactions
      where user_id = ${row.user_id}
        and type = 'ad_reward'
        and created_at >= date_trunc('day', now())
    `;

    const retryAfterSeconds = adThrottleSecondsRemaining(
      rewardStats[0] ?? { total: 0, last_rewarded_at: null }
    );

    if (retryAfterSeconds > 0) {
      await tx`
        update ad_claims
        set
          status = 'cooldown',
          postback_received_at = now(),
          last_event_type = ${payload.event_type ?? null},
          last_reward_event_type = ${payload.reward_event_type ?? null},
          last_estimated_price = ${payload.estimated_price ?? null},
          last_zone_id = ${payload.zone_id ?? null},
          last_sub_zone_id = ${payload.sub_zone_id ?? null},
          last_telegram_id = ${payload.telegram_id ?? null},
          last_postback = ${JSON.stringify(payload)}::jsonb
        where ymid = ${payload.ymid}
      `;

      return { status: "processed" as const, rewarded: false };
    }

    if (Number(row.reward_amount) > 0) {
      await creditUserInTx(
        tx,
        Number(row.user_id),
        Number(row.reward_amount),
        "ad_reward",
        `Monetag rewarded ad ${row.ymid}`
      );
      await addFondoRevenueInTx(tx, payload.estimated_price);
    }

    await tx`
      update ad_claims
      set
        status = 'rewarded',
        rewarded_at = now(),
        postback_received_at = now(),
        last_event_type = ${payload.event_type ?? null},
        last_reward_event_type = ${payload.reward_event_type ?? null},
        last_estimated_price = ${payload.estimated_price ?? null},
        last_zone_id = ${payload.zone_id ?? null},
        last_sub_zone_id = ${payload.sub_zone_id ?? null},
        last_telegram_id = ${payload.telegram_id ?? null},
        last_postback = ${JSON.stringify(payload)}::jsonb
      where ymid = ${payload.ymid}
    `;

    return { status: "processed" as const, rewarded: true, userId: row.user_id };
  });

  if (result.status === "ignored" && result.reason === "unknown_ymid") {
    await logFraud("monetag_unknown_ymid", payload);
  }

  if (result.status === "ignored" && result.reason === "postback_mismatch") {
    await logFraud(
      "monetag_postback_mismatch",
      payload,
      "userId" in result ? Number(result.userId) : null
    );
  }

  return result;
}

export async function createDropX2AdAttempt(params: {
  dropId: string;
  userId: number;
  zoneId: string;
  requestVar?: string;
}): Promise<
  | { status: "ok"; attempt: AdAttemptState }
  | { status: "invalid_zone" | "cooldown" }
> {
  if (!isConfiguredMonetagZone(params.zoneId)) {
    return { status: "invalid_zone" };
  }

  const eventId = `dropx2_${params.dropId}`;

  const reusableRows = await sql<AdClaimRow[]>`
    select
      token, event_id, user_id, ymid, sdk_zone_id, reward_amount, request_var, status,
      frontend_resolved_at, frontend_failed_at, frontend_error,
      postback_received_at, rewarded_at, last_event_type, last_reward_event_type,
      expires_at, created_at
    from ad_claims
    where event_id = ${eventId}
      and user_id = ${params.userId}
      and status = 'pending'
      and expires_at > now()
    order by created_at desc
    limit 1
  `;

  if (reusableRows[0]) {
    return { status: "ok", attempt: mapAttempt(reusableRows[0]) };
  }

  const cooldown = await acquireCooldown("ad_attempt", params.userId, 2);
  if (!cooldown) {
    return { status: "cooldown" };
  }

  const token = crypto.randomUUID();
  const ymid = crypto.randomUUID();
  const expiresAt = addSeconds(new Date(), appConfig.adClaimTtlSeconds).toISOString();
  const requestVar = params.requestVar ?? env.monetagRequestVar;

  const rows = await sql<AdClaimRow[]>`
    insert into ad_claims (
      token, event_id, user_id, ymid, sdk_zone_id, reward_amount, request_var, status, expires_at
    )
    values (
      ${token}, ${eventId}, ${params.userId}, ${ymid}, ${params.zoneId},
      0, ${requestVar}, 'pending', ${expiresAt}
    )
    returning
      token, event_id, user_id, ymid, sdk_zone_id, reward_amount, request_var, status,
      frontend_resolved_at, frontend_failed_at, frontend_error,
      postback_received_at, rewarded_at, last_event_type, last_reward_event_type,
      expires_at, created_at
  `;

  return { status: "ok", attempt: mapAttempt(rows[0]) };
}

export function buildDropX2WebAppHtml(input: {
  dropId: string;
  dropReward: number;
  zoneId: string;
  sdkUrl: string;
  requestVar: string;
}): string {
  const safeDropId = JSON.stringify(input.dropId);
  const safeDropReward = JSON.stringify(input.dropReward);
  const safeZoneId = JSON.stringify(input.zoneId);
  const safeSdkUrl = JSON.stringify(input.sdkUrl);
  const safeRequestVar = JSON.stringify(input.requestVar);
  const safePollTries = JSON.stringify(appConfig.adAttemptPollMaxTries);
  const safePollIntervalMs = JSON.stringify(appConfig.adAttemptPollIntervalMs);

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>La Esquina | Lucky Drop x2</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7efde;
        --card: rgba(255, 250, 241, 0.96);
        --ink: #20170e;
        --muted: #6e6251;
        --line: rgba(32, 23, 14, 0.11);
        --accent: #b54a19;
        --accent-2: #f39c12;
        --ok: #1d7a44;
        --warn: #a65e00;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        background:
          radial-gradient(circle at top left, rgba(243, 156, 18, 0.3), transparent 30%),
          radial-gradient(circle at bottom right, rgba(181, 74, 25, 0.14), transparent 26%),
          linear-gradient(180deg, #fff7ea 0%, var(--bg) 100%);
        color: var(--ink);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .card {
        width: min(100%, 420px);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 20px 48px rgba(54, 37, 17, 0.12);
        padding: 24px;
      }
      .eyebrow {
        margin-bottom: 10px;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--muted);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 30px;
        line-height: 1.04;
      }
      p {
        margin: 0 0 14px;
        color: var(--muted);
        line-height: 1.52;
      }
      .reward {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(243, 156, 18, 0.16);
        color: var(--ink);
        font-weight: 700;
      }
      .actions {
        margin-top: 18px;
      }
      button {
        width: 100%;
        appearance: none;
        border: 0;
        border-radius: 15px;
        padding: 15px 18px;
        font-size: 16px;
        font-weight: 700;
        color: #fff;
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        cursor: pointer;
      }
      button[disabled] {
        opacity: 0.65;
        cursor: not-allowed;
      }
      .status {
        margin-top: 16px;
        min-height: 44px;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(32, 23, 14, 0.04);
        color: var(--ink);
        line-height: 1.4;
      }
      .status.ok { color: var(--ok); }
      .status.warn { color: var(--warn); }
      .meta {
        margin-top: 12px;
        font-size: 13px;
      }
      code {
        font-family: Consolas, monospace;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow">La Esquina &mdash; Lucky Drop</div>
      <h1>Abrir x2 🎬</h1>
      <div class="reward">+<span id="reward"></span> 🪙</div>
      <p id="intro">Mira el anuncio para reclamar el Lucky Drop con recompensa doble.</p>
      <div class="actions">
        <button id="watch">Ver anuncio</button>
      </div>
      <div class="status" id="status">Preparando Monetag...</div>
      <p class="meta">Zona seleccionada para este intento: <code id="zone"></code></p>
    </main>
    <script>
      const dropId = ${safeDropId};
      const dropReward = ${safeDropReward};
      const reward = dropReward * 2;
      const zoneId = ${safeZoneId};
      const sdkUrl = ${safeSdkUrl};
      const requestVar = ${safeRequestVar};
      const maxPollTries = ${safePollTries};
      const pollIntervalMs = ${safePollIntervalMs};
      const tg = window.Telegram.WebApp;
      const monetagFnName = "show_" + zoneId;
      const sdkScriptId = "monetag-sdk-" + zoneId;
      const sdkCandidates = Array.from(
        new Set([sdkUrl, window.location.origin + "/api/monetag-sdk"])
      );
      let sdkReadyPromise = null;
      let sessionToken = null;

      tg.ready();
      tg.expand();

      const rewardEl = document.getElementById("reward");
      const statusEl = document.getElementById("status");
      const watchButton = document.getElementById("watch");
      const zoneEl = document.getElementById("zone");
      const introEl = document.getElementById("intro");

      rewardEl.textContent = String(reward);
      zoneEl.textContent = zoneId;

      const user = tg.initDataUnsafe?.user;
      if (user?.first_name) {
        introEl.textContent =
          "Hola " +
          user.first_name +
          ". Mira el anuncio para reclamar " + reward + " coins del Lucky Drop.";
      }

      function setStatus(message, tone) {
        statusEl.textContent = message;
        statusEl.className = tone ? "status " + tone : "status";
      }

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function scrubTelegramInitData() {
        try { tg.initData = ""; } catch {}
        try { tg.initDataUnsafe = {}; } catch {}
        try {
          if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.initData = "";
            window.Telegram.WebApp.initDataUnsafe = {};
          }
        } catch {}
      }

      async function ensureBackendSession() {
        if (sessionToken) return sessionToken;
        const response = await fetch("/api/webapp-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ initData: tg.initData })
        });
        const payload = await response.json();
        if (!response.ok || typeof payload.sessionToken !== "string") {
          throw new Error(payload.error || "No se pudo abrir una sesion segura de la Mini App.");
        }
        sessionToken = payload.sessionToken;
        scrubTelegramInitData();
        return sessionToken;
      }

      function getMonetagShow(optional) {
        const fn = window[monetagFnName];
        if (typeof fn !== "function") {
          if (optional) return null;
          throw new Error("El SDK de Monetag todavia no termino de cargar.");
        }
        return fn;
      }

      function loadMonetagScript(candidateUrl) {
        return new Promise((resolve, reject) => {
          const existing = document.getElementById(sdkScriptId);
          if (existing) existing.remove();
          const script = document.createElement("script");
          script.id = sdkScriptId;
          script.src = candidateUrl;
          script.async = true;
          script.dataset.zone = zoneId;
          script.dataset.sdk = monetagFnName;
          script.onload = () => resolve(candidateUrl);
          script.onerror = () => reject(new Error("No se pudo cargar el SDK de Monetag desde " + candidateUrl));
          document.head.appendChild(script);
        });
      }

      async function ensureMonetagReady() {
        const existing = getMonetagShow(true);
        if (existing) return existing;
        if (!sdkReadyPromise) {
          sdkReadyPromise = (async () => {
            setStatus("Cargando SDK de Monetag...");
            let lastError = null;
            for (const candidateUrl of sdkCandidates) {
              try {
                await loadMonetagScript(candidateUrl);
                const deadline = Date.now() + 15000;
                while (Date.now() < deadline) {
                  const fn = getMonetagShow(true);
                  if (fn) {
                    setStatus("SDK listo. Host activo: " + new URL(candidateUrl, window.location.origin).host);
                    return fn;
                  }
                  await sleep(250);
                }
                lastError = new Error("El SDK cargo desde " + candidateUrl + ", pero la funcion " + monetagFnName + " no aparecio.");
              } catch (error) {
                lastError = error;
              }
            }
            throw lastError || new Error("El SDK de Monetag no termino de cargar.");
          })().catch((error) => {
            sdkReadyPromise = null;
            throw error;
          });
        }
        return sdkReadyPromise;
      }

      async function createAttempt() {
        const response = await fetch("/api/drop-x2-attempt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dropId, zoneId, sessionToken, requestVar })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "No se pudo iniciar el anuncio.");
        return payload;
      }

      async function fetchAttemptStatus(token, clientState, clientError) {
        const response = await fetch("/api/ad-done?token=" + encodeURIComponent(token), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionToken, clientState, clientError })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "No se pudo consultar el estado del reward.");
        return payload;
      }

      async function pollStatus(token, clientState, clientError) {
        let lastPayload = null;
        for (let index = 0; index < maxPollTries; index += 1) {
          lastPayload = await fetchAttemptStatus(token, clientState, clientError);
          if (lastPayload.state !== "pending") return lastPayload;
          await sleep(pollIntervalMs);
        }
        return lastPayload;
      }

      async function claimDropX2(adToken) {
        const response = await fetch("/api/drop-x2-claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dropId, adToken, sessionToken })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "No se pudo reclamar el drop.");
        return payload;
      }

      async function applyBackendState(payload, adToken) {
        if (payload.state === "rewarded") {
          setStatus("Anuncio confirmado. Reclamando drop...");
          try {
            const claim = await claimDropX2(adToken);
            setStatus("Ganaste " + claim.reward + " coins. Saldo: " + claim.balance + ".", "ok");
            tg.HapticFeedback?.notificationOccurred?.("success");
            setTimeout(() => tg.close(), 2000);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "No se pudo reclamar el drop.", "warn");
            tg.HapticFeedback?.notificationOccurred?.("warning");
            watchButton.disabled = false;
          }
          return;
        }

        if (payload.state === "limit_reached") {
          setStatus(payload.message || "Ya llegaste al limite diario de anuncios.", "warn");
          tg.HapticFeedback?.notificationOccurred?.("warning");
          watchButton.disabled = false;
          return;
        }

        if (payload.state === "cooldown") {
          setStatus(payload.message || "Debes esperar antes del siguiente anuncio.", "warn");
          tg.HapticFeedback?.notificationOccurred?.("warning");
          watchButton.disabled = false;
          return;
        }

        if (payload.state === "expired") {
          setStatus("Este intento ya expiro. Vuelve al grupo e intenta de nuevo.", "warn");
          tg.HapticFeedback?.notificationOccurred?.("warning");
          watchButton.disabled = false;
          return;
        }

        if (
          payload.lastRewardEventType === "not_valued" ||
          payload.lastRewardEventType === "non_valued"
        ) {
          setStatus("Monetag confirmo el intento, pero no salio valorizado. No se acreditaron coins.", "warn");
          tg.HapticFeedback?.notificationOccurred?.("warning");
          watchButton.disabled = false;
          return;
        }

        setStatus("Esperando confirmacion de Monetag. Toca Ver anuncio en unos segundos para reconsultar.");
        watchButton.disabled = false;
      }

      watchButton.disabled = true;
      setStatus("Validando sesion de Telegram...");

      ensureBackendSession()
        .then(() => ensureMonetagReady())
        .then(() => {
          watchButton.disabled = false;
          setStatus("Listo. Toca para ver el anuncio y ganar " + reward + " coins.");
        })
        .catch((error) => {
          watchButton.disabled = false;
          setStatus(error instanceof Error ? error.message : "No se pudo preparar Monetag.", "warn");
        });

      watchButton.addEventListener("click", async () => {
        let attempt = null;
        watchButton.disabled = true;
        setStatus("Preparando SDK...");

        try {
          await ensureBackendSession();
          const showAd = await ensureMonetagReady();

          setStatus("Creando intento seguro...");
          attempt = await createAttempt();

          setStatus("Precargando anuncio...");
          await showAd({ type: "preload", ymid: attempt.ymid, requestVar });

          setStatus("Mostrando anuncio...");
          const frontendEvent = await showAd({ ymid: attempt.ymid, requestVar });

          if (frontendEvent?.reward_event_type === "valued") {
            setStatus("Anuncio visto. Verificando con el backend...");
            const result = await pollStatus(attempt.token, "resolved", null);
            await applyBackendState(result, attempt.token);
          } else {
            const clientError = frontendEvent?.reward_event_type ?? "unknown_frontend_event";
            setStatus("El anuncio no salio valorizado en el cliente. Verificando...");
            const result = await pollStatus(attempt.token, "failed", clientError);
            await applyBackendState(result, attempt.token);
          }
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Ocurrio un error inesperado.", "warn");
          if (attempt) {
            pollStatus(attempt.token, "failed", error instanceof Error ? error.message : "unknown").catch(() => undefined);
          }
          watchButton.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}

export function buildAdWebAppHtml(input: {
  eventId: string;
  reward: number;
  zoneId: string;
  sdkUrl: string;
  requestVar: string;
}): string {
  const safeEventId = JSON.stringify(input.eventId);
  const safeReward = JSON.stringify(input.reward);
  const safeZoneId = JSON.stringify(input.zoneId);
  const safeSdkUrl = JSON.stringify(input.sdkUrl);
  const safeRequestVar = JSON.stringify(input.requestVar);
  const safePollTries = JSON.stringify(appConfig.adAttemptPollMaxTries);
  const safePollIntervalMs = JSON.stringify(appConfig.adAttemptPollIntervalMs);

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>La Esquina | Monetag Rewarded</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7efde;
        --card: rgba(255, 250, 241, 0.96);
        --ink: #20170e;
        --muted: #6e6251;
        --line: rgba(32, 23, 14, 0.11);
        --accent: #b54a19;
        --accent-2: #f39c12;
        --ok: #1d7a44;
        --warn: #a65e00;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        background:
          radial-gradient(circle at top left, rgba(243, 156, 18, 0.3), transparent 30%),
          radial-gradient(circle at bottom right, rgba(181, 74, 25, 0.14), transparent 26%),
          linear-gradient(180deg, #fff7ea 0%, var(--bg) 100%);
        color: var(--ink);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .card {
        width: min(100%, 420px);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 20px 48px rgba(54, 37, 17, 0.12);
        padding: 24px;
      }
      .eyebrow {
        margin-bottom: 10px;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--muted);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 30px;
        line-height: 1.04;
      }
      p {
        margin: 0 0 14px;
        color: var(--muted);
        line-height: 1.52;
      }
      .reward {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(243, 156, 18, 0.16);
        color: var(--ink);
        font-weight: 700;
      }
      .actions {
        margin-top: 18px;
      }
      button {
        width: 100%;
        appearance: none;
        border: 0;
        border-radius: 15px;
        padding: 15px 18px;
        font-size: 16px;
        font-weight: 700;
        color: #fff;
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        cursor: pointer;
      }
      button[disabled] {
        opacity: 0.65;
        cursor: not-allowed;
      }
      .status {
        margin-top: 16px;
        min-height: 44px;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(32, 23, 14, 0.04);
        color: var(--ink);
        line-height: 1.4;
      }
      .status.ok { color: var(--ok); }
      .status.warn { color: var(--warn); }
      .meta {
        margin-top: 12px;
        font-size: 13px;
      }
      code {
        font-family: Consolas, monospace;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow">La Esquina</div>
      <h1>Rewarded del barrio</h1>
      <div class="reward">+<span id="reward"></span> 🪙</div>
      <p id="intro">Abrí el rewarded dentro de Telegram. Las coins solo se acreditan cuando llega el postback válido de Monetag al backend.</p>
      <div class="actions">
        <button id="watch">Ver anuncio</button>
      </div>
      <div class="status" id="status">Preparando Monetag...</div>
      <p class="meta">Zona seleccionada para este intento: <code id="zone"></code></p>
    </main>
    <script>
      const eventId = ${safeEventId};
      const reward = ${safeReward};
      const zoneId = ${safeZoneId};
      const sdkUrl = ${safeSdkUrl};
      const requestVar = ${safeRequestVar};
      const maxPollTries = ${safePollTries};
      const pollIntervalMs = ${safePollIntervalMs};
      const tg = window.Telegram.WebApp;
      const monetagFnName = "show_" + zoneId;
      const sdkScriptId = "monetag-sdk-" + zoneId;
      const sdkCandidates = Array.from(
        new Set([sdkUrl, window.location.origin + "/api/monetag-sdk"])
      );
      let sdkReadyPromise = null;
      let sessionToken = null;

      tg.ready();
      tg.expand();

      const rewardEl = document.getElementById("reward");
      const statusEl = document.getElementById("status");
      const watchButton = document.getElementById("watch");
      const zoneEl = document.getElementById("zone");
      const introEl = document.getElementById("intro");

      rewardEl.textContent = String(reward);
      zoneEl.textContent = zoneId;

      const user = tg.initDataUnsafe?.user;
      if (user?.first_name) {
        introEl.textContent =
          "Hola " +
          user.first_name +
          ". Las coins solo entran cuando el backend recibe un postback valued de Monetag para este intento.";
      }

      function setStatus(message, tone) {
        statusEl.textContent = message;
        statusEl.className = tone ? "status " + tone : "status";
      }

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function scrubTelegramInitData() {
        try {
          tg.initData = "";
        } catch {}

        try {
          tg.initDataUnsafe = {};
        } catch {}

        try {
          if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.initData = "";
            window.Telegram.WebApp.initDataUnsafe = {};
          }
        } catch {}
      }

      async function ensureBackendSession() {
        if (sessionToken) {
          return sessionToken;
        }

        const response = await fetch("/api/webapp-session", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            initData: tg.initData
          })
        });

        const payload = await response.json();
        if (!response.ok || typeof payload.sessionToken !== "string") {
          throw new Error(payload.error || "No se pudo abrir una sesion segura de la Mini App.");
        }

        sessionToken = payload.sessionToken;
        scrubTelegramInitData();
        return sessionToken;
      }

      function getMonetagShow(optional) {
        const fn = window[monetagFnName];
        if (typeof fn !== "function") {
          if (optional) {
            return null;
          }
          throw new Error("El SDK de Monetag todavia no termino de cargar.");
        }
        return fn;
      }

      function loadMonetagScript(candidateUrl) {
        return new Promise((resolve, reject) => {
          const existing = document.getElementById(sdkScriptId);
          if (existing) {
            existing.remove();
          }

          const script = document.createElement("script");
          script.id = sdkScriptId;
          script.src = candidateUrl;
          script.async = true;
          script.dataset.zone = zoneId;
          script.dataset.sdk = monetagFnName;
          script.onload = () => resolve(candidateUrl);
          script.onerror = () => reject(new Error("No se pudo cargar el SDK de Monetag desde " + candidateUrl));
          document.head.appendChild(script);
        });
      }

      async function ensureMonetagReady() {
        const existing = getMonetagShow(true);
        if (existing) {
          return existing;
        }

        if (!sdkReadyPromise) {
          sdkReadyPromise = (async () => {
            setStatus("Cargando SDK de Monetag...");
            let lastError = null;

            for (const candidateUrl of sdkCandidates) {
              try {
                await loadMonetagScript(candidateUrl);

                const deadline = Date.now() + 15000;
                while (Date.now() < deadline) {
                  const fn = getMonetagShow(true);
                  if (fn) {
                    setStatus(
                      "SDK listo. Host activo: " + new URL(candidateUrl, window.location.origin).host
                    );
                    return fn;
                  }
                  await sleep(250);
                }

                lastError = new Error(
                  "El SDK cargo desde " + candidateUrl + ", pero la funcion " + monetagFnName + " no aparecio."
                );
              } catch (error) {
                lastError = error;
              }
            }

            throw lastError || new Error("El SDK de Monetag no termino de cargar.");
          })().catch((error) => {
            sdkReadyPromise = null;
            throw error;
          });
        }

        return sdkReadyPromise;
      }

      async function createAttempt() {
        const response = await fetch("/api/ad-attempt", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            eventId,
            zoneId,
            sessionToken,
            requestVar
          })
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "No se pudo iniciar el anuncio.");
        }
        return payload;
      }

      async function fetchAttemptStatus(token, clientState, clientError) {
        const response = await fetch("/api/ad-done?token=" + encodeURIComponent(token), {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            sessionToken,
            clientState,
            clientError
          })
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "No se pudo consultar el estado del reward.");
        }
        return payload;
      }

      async function pollStatus(token, clientState, clientError) {
        let lastPayload = null;

        for (let index = 0; index < maxPollTries; index += 1) {
          lastPayload = await fetchAttemptStatus(token, clientState, clientError);
          if (lastPayload.state !== "pending") {
            return lastPayload;
          }
          await sleep(pollIntervalMs);
        }

        return lastPayload;
      }

      function applyBackendState(payload) {
        if (payload.state === "rewarded") {
          setStatus(payload.message || "Reward acreditado.", "ok");
          tg.HapticFeedback?.notificationOccurred?.("success");
          setTimeout(() => tg.close(), 1400);
          return;
        }

        if (payload.state === "limit_reached") {
          setStatus(payload.message || "Ya llegaste al limite diario de anuncios.", "warn");
          tg.HapticFeedback?.notificationOccurred?.("warning");
          watchButton.disabled = false;
          return;
        }

        if (payload.state === "cooldown") {
          setStatus(payload.message || "Debes esperar antes del siguiente anuncio.", "warn");
          tg.HapticFeedback?.notificationOccurred?.("warning");
          watchButton.disabled = false;
          return;
        }

        if (payload.state === "expired") {
          setStatus(payload.message || "Este intento ya expiro. Volve al grupo y abri otro anuncio.", "warn");
          tg.HapticFeedback?.notificationOccurred?.("warning");
          watchButton.disabled = false;
          return;
        }

        if (
          payload.lastRewardEventType === "not_valued" ||
          payload.lastRewardEventType === "non_valued"
        ) {
          setStatus(
            payload.message || "Monetag confirmo el intento, pero no salio valorizado. No se acreditaron coins.",
            "warn"
          );
          tg.HapticFeedback?.notificationOccurred?.("warning");
          watchButton.disabled = false;
          return;
        }

        setStatus(
          payload.message || "Seguimos esperando el postback valido de Monetag. Si tarda demasiado, vuelve a tocar Ver anuncio en unos segundos para reconsultar el estado."
        );
        watchButton.disabled = false;
      }

      watchButton.disabled = true;
      setStatus("Validando sesion de Telegram...");

      ensureBackendSession()
        .then(() => ensureMonetagReady())
        .then(() => {
          watchButton.disabled = false;
          setStatus("Mini App lista. Toca para abrir un Rewarded Interstitial.");
        })
        .catch((error) => {
          watchButton.disabled = false;
          setStatus(
            error instanceof Error ? error.message : "No se pudo preparar Monetag.",
            "warn"
          );
        });

      watchButton.addEventListener("click", async () => {
        let attempt = null;
        watchButton.disabled = true;
        setStatus("Preparando SDK...");

        try {
          await ensureBackendSession();
          const showAd = await ensureMonetagReady();

          setStatus("Creando intento seguro...");
          attempt = await createAttempt();

          setStatus("Precargando anuncio...");
          await showAd({
            type: "preload",
            ymid: attempt.ymid,
            requestVar
          });

          setStatus("Mostrando anuncio...");
          const frontendEvent = await showAd({
            ymid: attempt.ymid,
            requestVar
          });

          if (frontendEvent?.reward_event_type === "valued") {
            setStatus("Monetag marco el evento como valued. Verificando postback en backend...");
          } else {
            setStatus("El frontend termino, pero el reward depende del postback del backend...");
          }

          const backendState = await pollStatus(attempt.token, "resolved", null);
          applyBackendState(backendState);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "El anuncio fallo, fue salteado o entro en timeout.";

          if (attempt?.token) {
            try {
              const backendState = await fetchAttemptStatus(attempt.token, "failed", message);
              if (backendState.state === "rewarded") {
                applyBackendState(backendState);
                return;
              }
            } catch {
              // Ignore secondary status failures and keep the original UX message.
            }
          }

          setStatus(message, "warn");
          tg.HapticFeedback?.notificationOccurred?.("error");
          watchButton.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}
