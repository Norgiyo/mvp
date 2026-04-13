import crypto from "node:crypto";

import type { Api } from "grammy";

import { env } from "../config";
import { redis } from "../db/redis";
import { sql } from "../db/postgres";
import type { MiningState } from "../types";
import { acquireCooldown, getCooldownTtl, withRedisLock } from "./antiAbuse";
import { creditUserInTx } from "./coins";
import { getUserPublicProfile } from "./users";
import { encodeCallback } from "../utils/callbackData";
import { addSeconds } from "../utils/time";

const PICKAXE_EMOJI = String.fromCodePoint(0x26CF);
const COIN_EMOJI = String.fromCodePoint(0x1FA99);
const MINING_TOTAL_ORE = 180;
const MINING_REWARD_COINS = 400;
const MINING_MIN_HIT = 1;
const MINING_MAX_HIT = 5;
const MINING_COOLDOWN_SECONDS = 60;
const MINING_DURATION_SECONDS = 60 * 60 * 6;

type MiningCloseReason = "depleted" | "expired" | "manual" | "replaced";

type MiningParticipantReward = {
  userId: number;
  ore: number;
  reward: number;
};

export type MiningCloseResult =
  | {
      status: "closed";
      reason: MiningCloseReason;
      participantCount: number;
      totalMined: number;
      rewardCoins: number;
      topMinerId: number | null;
      closedMessageId: number | null;
    }
  | { status: "not_found" };

function miningStateKey(): string {
  return "mining:state";
}

function miningHitsKey(eventId: string): string {
  return `mining:hits:${eventId}`;
}

function parseStateTtlSeconds(expiresAt: string): number {
  const remaining = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000);
  return Math.max(60 * 60, remaining + 24 * 60 * 60);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRemaining(expiresAt: string): string {
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

function progressBar(remainingOre: number, totalOre: number): string {
  const width = 10;
  const minedRatio = Math.min(1, Math.max(0, (totalOre - remainingOre) / totalOre));
  const filled = Math.round(minedRatio * width);
  return `${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
}

function miningText(state: MiningState, participantCount: number): string {
  const mined = state.totalOre - state.remainingOre;
  return [
    `<b>${PICKAXE_EMOJI} MINA ACTIVA</b>`,
    `Reserva: <b>${state.remainingOre}</b> / ${state.totalOre}`,
    `Progreso: <code>${progressBar(state.remainingOre, state.totalOre)}</code> ${mined}/${state.totalOre}`,
    `Mineros: <b>${participantCount}</b>`,
    `Pool final: <b>${state.rewardCoins} ${COIN_EMOJI}</b>`,
    `Cierra en: <b>${formatRemaining(state.expiresAt)}</b>`,
    "",
    "Cada vecino puede minar una vez por minuto.",
    "Cuando la veta se agota o se acaba el tiempo, el bot reparte las coins segun lo minado."
  ].join("\n");
}

function miningMarkup(eventId: string) {
  return {
    inline_keyboard: [
      [
        {
          text: `${PICKAXE_EMOJI} Minar`,
          callback_data: encodeCallback("mining", eventId),
          style: "success" as const
        }
      ]
    ]
  };
}

function randomHitAmount(): number {
  return Math.floor(Math.random() * (MINING_MAX_HIT - MINING_MIN_HIT + 1)) + MINING_MIN_HIT;
}

async function getMiningState(): Promise<MiningState | null> {
  return redis.get<MiningState>(miningStateKey());
}

async function saveMiningState(state: MiningState): Promise<void> {
  await redis.set(miningStateKey(), state, { ex: parseStateTtlSeconds(state.expiresAt) });
}

async function deleteMiningState(): Promise<void> {
  await redis.del(miningStateKey());
}

async function getMiningHitMap(eventId: string): Promise<Record<string, string>> {
  return (await redis.hgetall<Record<string, string>>(miningHitsKey(eventId))) ?? {};
}

function parseMiningParticipants(hitMap: Record<string, string>): MiningParticipantReward[] {
  return Object.entries(hitMap)
    .map(([userId, ore]) => ({
      userId: Number(userId),
      ore: Number.parseInt(ore, 10),
      reward: 0
    }))
    .filter((entry) => Number.isFinite(entry.userId) && Number.isFinite(entry.ore) && entry.ore > 0);
}

function allocateMiningRewards(
  entries: MiningParticipantReward[],
  rewardCoins: number
): MiningParticipantReward[] {
  const totalOre = entries.reduce((sum, entry) => sum + entry.ore, 0);
  if (totalOre <= 0 || rewardCoins <= 0) {
    return entries;
  }

  const ranked = [...entries].sort((a, b) => {
    if (b.ore !== a.ore) {
      return b.ore - a.ore;
    }
    return a.userId - b.userId;
  });

  let distributed = 0;
  for (const entry of ranked) {
    entry.reward = Math.floor((rewardCoins * entry.ore) / totalOre);
    distributed += entry.reward;
  }

  let leftover = rewardCoins - distributed;
  let index = 0;
  while (leftover > 0 && ranked.length > 0) {
    ranked[index % ranked.length]!.reward += 1;
    leftover -= 1;
    index += 1;
  }

  return ranked;
}

async function deleteMiningMessage(api: Api, state: MiningState): Promise<void> {
  await api.deleteMessage(state.chatId, state.messageId).catch(() => undefined);
}

async function updateMiningMessage(api: Api, state: MiningState): Promise<void> {
  const participants = parseMiningParticipants(await getMiningHitMap(state.id));
  await api
    .editMessageText(state.chatId, state.messageId, miningText(state, participants.length), {
      parse_mode: "HTML",
      reply_markup: miningMarkup(state.id)
    })
    .catch(() => undefined);
}

async function announceMiningClosure(
  api: Api,
  state: MiningState,
  reason: MiningCloseReason,
  rewards: MiningParticipantReward[]
): Promise<void> {
  const totalMined = state.totalOre - state.remainingOre;
  if (rewards.length === 0) {
    const reasonText =
      reason === "expired"
        ? "Se acabo el tiempo y nadie mino."
        : reason === "manual" || reason === "replaced"
          ? "La mina fue cerrada antes de tiempo y nadie llego a minar."
          : "La veta se agoto, pero nadie alcanzo a minar.";

    await api.sendMessage(
      state.chatId,
      `${PICKAXE_EMOJI} Mina cerrada\n\n${reasonText}`,
      { disable_notification: true }
    );
    return;
  }

  const lines: string[] = [];
  for (const [index, reward] of rewards.slice(0, 5).entries()) {
    const profile = await getUserPublicProfile(reward.userId);
    const label = profile?.username
      ? `@${profile.username}`
      : profile?.firstName || `user_${reward.userId}`;
    const mention = `<a href="tg://user?id=${reward.userId}">${escapeHtml(label)}</a>`;
    lines.push(`${index + 1}. ${mention} - ${reward.ore} mineral - +${reward.reward} ${COIN_EMOJI}`);
  }

  const topMinerId = rewards[0]?.userId ?? null;
  const topMiner = topMinerId ? await getUserPublicProfile(topMinerId) : null;
  const topMinerText = topMiner
    ? topMiner.username
      ? `@${topMiner.username}`
      : topMiner.firstName || `user_${topMiner.telegramId}`
    : topMinerId
      ? `user_${topMinerId}`
      : "nadie";
  const reasonText =
    reason === "expired"
      ? "Tiempo agotado"
      : reason === "manual"
        ? "Cierre manual"
        : reason === "replaced"
          ? "Reemplazada por una nueva mina"
          : "Veta agotada";

  await api.sendMessage(
    state.chatId,
    [
      `${PICKAXE_EMOJI} Mina cerrada`,
      "",
      `Motivo: <b>${escapeHtml(reasonText)}</b>`,
      `Mineral extraido: <b>${totalMined}</b> / ${state.totalOre}`,
      `Participantes: <b>${rewards.length}</b>`,
      `Pool repartido: <b>${state.rewardCoins} ${COIN_EMOJI}</b>`,
      `Top minero: <b>${escapeHtml(topMinerText)}</b>`,
      "",
      lines.join("\n")
    ].join("\n"),
    {
      disable_notification: true,
      parse_mode: "HTML"
    }
  );
}

async function closeMiningState(
  api: Api,
  state: MiningState,
  reason: MiningCloseReason
): Promise<MiningCloseResult> {
  const rawHits = await getMiningHitMap(state.id);
  const participants = allocateMiningRewards(parseMiningParticipants(rawHits), state.rewardCoins);

  if (participants.length > 0) {
    await sql.begin(async (tx: any) => {
      for (const participant of participants) {
        if (participant.reward <= 0) {
          continue;
        }

        await creditUserInTx(
          tx,
          participant.userId,
          participant.reward,
          "mining_reward",
          `Mineria ${state.id}: ${participant.ore} de mineral`
        );
      }
    });
  }

  await deleteMiningState();
  await redis.del(miningHitsKey(state.id));
  await deleteMiningMessage(api, state);
  await announceMiningClosure(api, state, reason, participants);

  return {
    status: "closed",
    reason,
    participantCount: participants.length,
    totalMined: state.totalOre - state.remainingOre,
    rewardCoins: state.rewardCoins,
    topMinerId: participants[0]?.userId ?? null,
    closedMessageId: state.messageId
  };
}

export async function closeActiveMiningAndAnnounce(
  api: Api,
  reason: Exclude<MiningCloseReason, "depleted"> = "manual"
): Promise<MiningCloseResult> {
  const result = await withRedisLock("mining:state", 20, async () => {
    const state = await getMiningState();
    if (!state) {
      return { status: "not_found" as const };
    }

    return closeMiningState(api, state, reason);
  });

  return result ?? { status: "not_found" };
}

export async function createNextMiningEvent(
  api: Api
): Promise<{ messageId: number; replaced: boolean }> {
  const result = await withRedisLock("mining:state", 20, async () => {
    const active = await getMiningState();
    let replaced = false;
    if (active) {
      await closeMiningState(api, active, "replaced");
      replaced = true;
    }

    const state: MiningState = {
      id: crypto.randomUUID(),
      chatId: env.groupChatId,
      messageId: 0,
      totalOre: MINING_TOTAL_ORE,
      remainingOre: MINING_TOTAL_ORE,
      rewardCoins: MINING_REWARD_COINS,
      createdAt: new Date().toISOString(),
      expiresAt: addSeconds(new Date(), MINING_DURATION_SECONDS).toISOString()
    };

    const message = await api.sendMessage(env.groupChatId, miningText(state, 0), {
      disable_notification: true,
      parse_mode: "HTML",
      reply_markup: miningMarkup(state.id)
    });

    const finalState: MiningState = {
      ...state,
      messageId: message.message_id
    };
    await saveMiningState(finalState);

    return {
      messageId: message.message_id,
      replaced
    };
  });

  if (!result) {
    throw new Error("MINING_CREATE_FAILED");
  }

  return result;
}

export async function mineOre(
  api: Api,
  eventId: string,
  userId: number
): Promise<
  | {
      status: "mined";
      extracted: number;
      remainingOre: number;
      totalOre: number;
      retryAfterSeconds: number;
      depleted: boolean;
    }
  | { status: "cooldown"; retryAfterSeconds: number }
  | { status: "not_found" | "busy" }
> {
  const result = await withRedisLock("mining:state", 20, async () => {
    const state = await getMiningState();
    if (!state || state.id !== eventId) {
      return { status: "not_found" as const };
    }

    if (new Date(state.expiresAt).getTime() <= Date.now()) {
      await closeMiningState(api, state, "expired");
      return { status: "not_found" as const };
    }

    const allowed = await acquireCooldown("mining_hit", userId, MINING_COOLDOWN_SECONDS);
    if (!allowed) {
      return {
        status: "cooldown" as const,
        retryAfterSeconds: await getCooldownTtl("mining_hit", userId)
      };
    }

    const extracted = Math.min(randomHitAmount(), state.remainingOre);
    await redis.hincrby(miningHitsKey(state.id), String(userId), extracted);
    await redis.expire(miningHitsKey(state.id), parseStateTtlSeconds(state.expiresAt));

    const nextState: MiningState = {
      ...state,
      remainingOre: Math.max(0, state.remainingOre - extracted)
    };

    if (nextState.remainingOre <= 0) {
      await closeMiningState(api, nextState, "depleted");
      return {
        status: "mined" as const,
        extracted,
        remainingOre: 0,
        totalOre: nextState.totalOre,
        retryAfterSeconds: MINING_COOLDOWN_SECONDS,
        depleted: true
      };
    }

    await saveMiningState(nextState);
    await updateMiningMessage(api, nextState);

    return {
      status: "mined" as const,
      extracted,
      remainingOre: nextState.remainingOre,
      totalOre: nextState.totalOre,
      retryAfterSeconds: MINING_COOLDOWN_SECONDS,
      depleted: false
    };
  });

  return result ?? { status: "busy" };
}

export async function cleanupExpiredMining(api: Api): Promise<void> {
  const state = await getMiningState();
  if (!state) {
    return;
  }

  if (new Date(state.expiresAt).getTime() > Date.now()) {
    return;
  }

  await closeActiveMiningAndAnnounce(api, "expired");
}
