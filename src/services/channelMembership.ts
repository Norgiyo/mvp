import type { Api } from "grammy";

import { env } from "../config";
import { isAdminUser } from "./users";

export async function isChannelMember(api: Api, userId: number): Promise<boolean> {
  const member = await api.getChatMember(env.groupChatId, userId).catch(() => null);
  if (!member) {
    return false;
  }

  return member.status !== "left" && member.status !== "kicked";
}

export async function canUseBot(api: Api, userId: number): Promise<boolean> {
  if (await isAdminUser(userId)) {
    return true;
  }

  return isChannelMember(api, userId);
}
