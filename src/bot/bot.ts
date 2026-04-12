import { Bot } from "grammy";

import { env } from "../config";
import { registerHandlers } from "./handlers";

let singleton: Bot | null = null;
let initPromise: Promise<Bot> | null = null;

export async function getBot(): Promise<Bot> {
  if (singleton) {
    return singleton;
  }

  if (initPromise) {
    return initPromise;
  }

  const bot = new Bot(env.botToken);
  registerHandlers(bot);
  bot.catch((error) => {
    console.error("Telegram bot error", error.error);
  });

  initPromise = bot
    .init()
    .then(() => {
      singleton = bot;
      return bot;
    })
    .finally(() => {
      if (!singleton) {
        initPromise = null;
      }
    });

  return initPromise;
}
