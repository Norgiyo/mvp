import type { Api } from "grammy";

import { env } from "../config";
import { redis } from "../db/redis";

type FondoPollState = {
  chatId: number;
  messageId: number;
  question: string;
  options: string[];
  createdAt: string;
};

type PollOption = {
  text: string;
  voter_count: number;
};

function activeFondoPollKey(): string {
  return `fondo:poll:active:${env.groupChatId}`;
}

function getDefaultFondoPollConfig(): { question: string; options: string[] } {
  return {
    question: "Que hacemos con 100 CUP del Fondo?",
    options: ["Premio semanal", "Subir Lucky Drop", "Guardar para mega sorteo"]
  };
}

export async function createFondoDecisionPoll(
  api: Api
): Promise<{ status: "created"; messageId: number } | { status: "already_active"; messageId: number }> {
  const key = activeFondoPollKey();
  const existing = await redis.get<FondoPollState>(key);
  if (existing?.messageId) {
    return { status: "already_active", messageId: existing.messageId };
  }

  const config = getDefaultFondoPollConfig();
  const message = await api.sendPoll(env.groupChatId, config.question, config.options, {
    is_anonymous: false,
    allows_multiple_answers: false,
    disable_notification: true
  });
  const state: FondoPollState = {
    chatId: env.groupChatId,
    messageId: message.message_id,
    question: config.question,
    options: config.options,
    createdAt: new Date().toISOString()
  };

  await redis.set(key, state);
  return { status: "created", messageId: message.message_id };
}

function summarizePollOptions(options: PollOption[]): { winnerText: string; lines: string[] } {
  const lines = options.map((option, index) => {
    const votes = Number(option.voter_count ?? 0);
    return `${index + 1}. ${option.text}: ${votes} voto${votes === 1 ? "" : "s"}`;
  });

  const maxVotes = Math.max(...options.map((option) => Number(option.voter_count ?? 0)), 0);
  if (maxVotes <= 0) {
    return { winnerText: "Sin votos", lines };
  }

  const winners = options
    .filter((option) => Number(option.voter_count ?? 0) === maxVotes)
    .map((option) => option.text);

  return { winnerText: winners.join(" / "), lines };
}

function isAlreadyClosedStopPollError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return (
    normalized.includes("poll has already been closed") ||
    normalized.includes("poll can't be stopped") ||
    normalized.includes("poll cant be stopped") ||
    normalized.includes("message with poll to stop not found") ||
    normalized.includes("message to stop poll not found") ||
    normalized.includes("message to edit not found") ||
    normalized.includes("message not found") ||
    normalized.includes("message can't be edited")
  );
}

export async function closeFondoDecisionPoll(
  api: Api
): Promise<{ status: "closed" } | { status: "not_found" | "already_closed" }> {
  const key = activeFondoPollKey();
  const state = await redis.get<FondoPollState>(key);
  if (!state) {
    return { status: "not_found" };
  }

  try {
    const poll = await api.stopPoll(state.chatId, state.messageId);
    const { winnerText, lines } = summarizePollOptions((poll.options as PollOption[]) ?? []);

    await api
      .sendMessage(
        state.chatId,
        `Resultado votacion del Fondo\n\n${state.question}\n\n${lines.join("\n")}\n\nGanador: ${winnerText}`,
        { disable_notification: true }
      )
      .catch(() => undefined);
    await redis.del(key);
    return { status: "closed" };
  } catch (error) {
    if (isAlreadyClosedStopPollError(error)) {
      await redis.del(key);
      return { status: "already_closed" };
    }
    throw error;
  }
}

export async function createNextFondoDecisionPoll(
  api: Api
): Promise<{ status: "created"; messageId: number; replacedPoll: boolean; previousMessageId: number | null }> {
  const key = activeFondoPollKey();
  const existing = await redis.get<FondoPollState>(key);
  const previousMessageId = existing?.messageId ?? null;
  let replacedPoll = false;

  if (existing?.messageId) {
    const closeResult = await closeFondoDecisionPoll(api);
    if (closeResult.status === "closed" || closeResult.status === "already_closed") {
      replacedPoll = true;
    }
  }

  const created = await createFondoDecisionPoll(api);
  if (created.status !== "created") {
    throw new Error("FONDO_POLL_CREATE_FAILED");
  }

  return {
    status: "created",
    messageId: created.messageId,
    replacedPoll,
    previousMessageId
  };
}
