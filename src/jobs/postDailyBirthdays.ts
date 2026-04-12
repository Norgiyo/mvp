import type { Api } from "grammy";

import { postBirthdaysForToday } from "../services/birthdays";

export async function postDailyBirthdays(api: Api): Promise<{ postedCount: number; totalBirthdays: number }> {
  return postBirthdaysForToday(api);
}
