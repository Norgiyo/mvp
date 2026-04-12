import type { Bot, Context } from "grammy";

import {
  clearUserBirthday,
  formatBirthdayMd,
  getUserBirthday,
  parseBirthdayInput,
  setUserBirthday
} from "../services/birthdays";
import { canUseBot } from "../services/channelMembership";
import { isAdminUser, upsertUser } from "../services/users";
import { toTelegramProfile } from "../utils/telegram";
import { handleCallbackQuery, sendAdminPanel } from "./callbacks";

function wantsAdminPanel(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "/start" ||
    normalized === "/admin" ||
    normalized === "admin" ||
    normalized === "panel" ||
    normalized === "menu"
  );
}

function wantsEmojiIdLookup(text: string): boolean {
  const { command } = splitCommandText(text);
  return command === "/emojiid" || command === "/emoji_id";
}

function splitCommandText(text: string): { command: string; arg: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { command: "", arg: "" };
  }

  const [rawCommand = "", ...rest] = trimmed.split(/\s+/);
  return {
    command: rawCommand.toLowerCase().split("@")[0] ?? "",
    arg: rest.join(" ").trim()
  };
}

function parseBirthdayCommand(text: string):
  | { kind: "show" }
  | { kind: "set"; birthdayMd: string }
  | { kind: "clear" }
  | { kind: "invalid" }
  | null {
  const { command, arg } = splitCommandText(text);
  if (command !== "/cumple" && command !== "/cumpleanos") {
    return null;
  }

  if (!arg) {
    return { kind: "show" };
  }

  const normalizedArg = arg.toLowerCase();
  if (normalizedArg === "borrar" || normalizedArg === "delete" || normalizedArg === "clear") {
    return { kind: "clear" };
  }

  const birthdayMd = parseBirthdayInput(arg);
  if (!birthdayMd) {
    return { kind: "invalid" };
  }

  return { kind: "set", birthdayMd };
}

function extractMessageText(message: any): string {
  if (typeof message?.text === "string") {
    return message.text;
  }

  if (typeof message?.caption === "string") {
    return message.caption;
  }

  return "";
}

function extractCustomEmojiIdsFromMessage(message: any): string[] {
  const ids = new Set<string>();

  for (const entity of [...(message?.entities ?? []), ...(message?.caption_entities ?? [])]) {
    if (entity?.type === "custom_emoji" && typeof entity.custom_emoji_id === "string") {
      ids.add(entity.custom_emoji_id);
    }
  }

  if (typeof message?.sticker?.custom_emoji_id === "string") {
    ids.add(message.sticker.custom_emoji_id);
  }

  return [...ids];
}

async function handleEmojiIdLookup(ctx: Context): Promise<boolean> {
  const message = ctx.message;
  if (!message || !message.from || message.chat.type !== "private") {
    return false;
  }

  const text = extractMessageText(message);
  if (!wantsEmojiIdLookup(text)) {
    return false;
  }

  const ids = extractCustomEmojiIdsFromMessage(message.reply_to_message ?? message);
  if (ids.length === 0) {
    await ctx.reply(
      "No encontre ningun custom emoji en ese mensaje.\n\nUsa /emojiid junto al emoji personalizado o responde con /emojiid al mensaje que lo tenga."
    );
    return true;
  }

  const lines = ids.map((id, index) => `${index + 1}. \`${id}\``);
  await ctx.reply(`Custom emoji ID${ids.length > 1 ? "s" : ""}:\n${lines.join("\n")}`, {
    parse_mode: "Markdown"
  });
  return true;
}

async function handleBirthdayCommand(ctx: Context): Promise<boolean> {
  const message = ctx.message;
  if (!message || !message.from || message.chat.type !== "private") {
    return false;
  }

  const command = parseBirthdayCommand(extractMessageText(message));
  if (!command) {
    return false;
  }

  if (command.kind === "show") {
    const birthdayMd = await getUserBirthday(message.from.id);
    if (!birthdayMd) {
      await ctx.reply("Guarda tu cumpleanos con /cumple DD/MM. Ejemplo: /cumple 25/03");
      return true;
    }

    await ctx.reply(
      `Tu cumpleanos guardado es ${formatBirthdayMd(birthdayMd)}.\n\nUsa /cumple DD/MM para cambiarlo o /cumple borrar para quitarlo.`
    );
    return true;
  }

  if (command.kind === "clear") {
    await clearUserBirthday(message.from.id);
    await ctx.reply("Tu cumpleanos fue borrado.");
    return true;
  }

  if (command.kind === "invalid") {
    await ctx.reply("Formato invalido. Usa /cumple DD/MM. Ejemplo: /cumple 25/03");
    return true;
  }

  await setUserBirthday(message.from.id, command.birthdayMd);
  await ctx.reply(`Cumpleanos guardado: ${formatBirthdayMd(command.birthdayMd)}.`);
  return true;
}

async function handlePrivateMessage(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !("text" in message) || !message.from || message.chat.type !== "private") {
    return;
  }
  const text = typeof message.text === "string" ? message.text : "";

  const actor = toTelegramProfile(message.from);
  const allowed = await canUseBot(ctx.api, message.from.id);
  if (!allowed) {
    await ctx.reply("Unete al canal para usar el bot.");
    return;
  }

  await upsertUser(actor);

  if (await handleEmojiIdLookup(ctx)) {
    return;
  }

  if (await handleBirthdayCommand(ctx)) {
    return;
  }

  if (await isAdminUser(message.from.id) && wantsAdminPanel(text)) {
    await sendAdminPanel(ctx.api, message.from.id);
    return;
  }

  await ctx.reply("La Esquina ya esta activa. Usa el panel privado o toca los botones del canal.");
}

export function registerHandlers(bot: Bot): void {
  bot.on("message", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      return;
    }

    await handlePrivateMessage(ctx);
  });

  bot.on("callback_query:data", handleCallbackQuery);
}
