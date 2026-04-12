import { getBot } from "../bot/bot";
import { maybePostAd } from "./maybePostAd";
import { maybePostIdleEvent } from "./maybePostIdleEvent";
import { maybePostLuckyDrop } from "./maybePostLuckyDrop";
import { postDailyBirthdays } from "./postDailyBirthdays";
import { postDailyReward } from "./postDailyReward";
import { runWeeklyLeaderboard } from "./postWeeklyLeaderboard";
import { runAuctionTick } from "./tickAuction";
import { cleanupExpiredEventMessages } from "../services/eventCleanup";

export const railwayJobNames = [
  "auction-tick",
  "cleanup-expired",
  "daily-birthdays",
  "daily-reward",
  "weekly-leaderboard",
  "maybe-post-ad",
  "maybe-post-lucky-drop",
  "maybe-post-idle-event"
] as const;

export type RailwayJobName = (typeof railwayJobNames)[number];

export function isRailwayJobName(job: string): job is RailwayJobName {
  return railwayJobNames.includes(job as RailwayJobName);
}

export async function runRailwayJob(job: RailwayJobName) {
  const bot = await getBot();
  const api = bot.api;

  switch (job) {
    case "auction-tick":
      return runAuctionTick(api);
    case "cleanup-expired":
      await cleanupExpiredEventMessages(api);
      return { status: "cleaned" as const };
    case "daily-birthdays":
      return postDailyBirthdays(api);
    case "daily-reward":
      return postDailyReward(api);
    case "weekly-leaderboard":
      return runWeeklyLeaderboard(api);
    case "maybe-post-ad":
      return maybePostAd(api, { force: true });
    case "maybe-post-lucky-drop":
      return maybePostLuckyDrop(api, { force: true });
    case "maybe-post-idle-event":
      return maybePostIdleEvent(api);
  }
}
