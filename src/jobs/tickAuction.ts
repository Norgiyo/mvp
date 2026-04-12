import type { Api } from "grammy";

import { tickAuction } from "../services/auction";

export async function runAuctionTick(api: Api) {
  return tickAuction(api);
}
