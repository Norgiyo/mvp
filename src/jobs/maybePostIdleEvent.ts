import type { Api } from "grammy";

import { canPostIdleEvent, getNextIdleEventKinds, markIdleEventPosted } from "../services/activity";
import { maybePostAd } from "./maybePostAd";
import { maybePostLuckyDrop } from "./maybePostLuckyDrop";

export async function maybePostIdleEvent(
  api: Api,
  options: { force?: boolean } = {}
): Promise<{ posted: boolean; kind?: "ad" | "drop"; reason?: string }> {
  if (!options.force) {
    const allowed = await canPostIdleEvent();
    if (!allowed) {
      return { posted: false, reason: "group_active_or_global_cooldown" };
    }
  }

  const kinds = await getNextIdleEventKinds();
  for (const kind of kinds) {
    const result = kind === "ad" ? await maybePostAd(api, options) : await maybePostLuckyDrop(api, options);

    if (result.posted) {
      await markIdleEventPosted(kind);
      return { posted: true, kind };
    }
  }

  return { posted: false, reason: "all_event_cooldowns_active" };
}
