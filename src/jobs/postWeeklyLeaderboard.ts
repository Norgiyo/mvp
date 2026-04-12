import type { Api } from "grammy";

import { postWeeklyLeaderboard } from "../services/leaderboard";

export async function runWeeklyLeaderboard(api: Api): Promise<{
  posted: boolean;
  weekKey: string;
  bonusGiven: boolean;
  winnerId: number | null;
}> {
  return postWeeklyLeaderboard(api);
}

