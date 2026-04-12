import type { Api } from "grammy";

import { postAdEvent } from "../services/ads";
import { cleanupExpiredEventMessages } from "../services/eventCleanup";

export async function maybePostAd(
  api: Api,
  options: { force?: boolean } = {}
): Promise<{ posted: boolean }> {
  await cleanupExpiredEventMessages(api);
  const event = await postAdEvent(api, options);
  return { posted: Boolean(event) };
}
