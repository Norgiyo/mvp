export type TelegramProfile = {
  id: number;
  username?: string | null;
  first_name?: string | null;
};

export type RewardType =
  | "ad_reward"
  | "daily_reward"
  | "lucky_drop"
  | "mining_reward"
  | "birthday_gift_sent"
  | "birthday_gift_received"
  | "auction_bid"
  | "auction_refund"
  | "auction_prize"
  | "weekly_leaderboard_bonus"
  | "raffle_entry"
  | "raffle_prize";

export type CallbackAction =
  | "balance"
  | "daily"
  | "drop"
  | "mining"
  | "birthday"
  | "auction"
  | "raffle"
  | "admin";

export type CallbackPayload = {
  action: CallbackAction;
  value?: string;
};

export type AdEventState = {
  id: string;
  reward: number;
  createdAt: string;
  expiresAt: string;
  messageId: number;
};

export type AdAttemptStatus =
  | "pending"
  | "rewarded"
  | "not_valued"
  | "limit_reached"
  | "cooldown"
  | "expired";

export type AdAttemptState = {
  token: string;
  eventId: string;
  userId: number;
  ymid: string;
  zoneId: string;
  rewardAmount: number;
  status: AdAttemptStatus;
  expiresAt: string;
  createdAt: string;
  rewardedAt: string | null;
  postbackReceivedAt: string | null;
  lastRewardEventType: string | null;
  lastEventType: string | null;
};

export type AdAttemptUiState = "resolved" | "failed";

export type MonetagPostbackPayload = {
  ymid: string;
  event_type?: string;
  reward_event_type?: string;
  estimated_price?: string;
  zone_id?: string;
  sub_zone_id?: string;
  request_var?: string;
  telegram_id?: string;
};

export type LuckyDropState = {
  id: string;
  reward: number;
  messageId: number;
  expiresAt: string;
};

export type MiningState = {
  id: string;
  chatId: number;
  messageId: number;
  totalOre: number;
  remainingOre: number;
  rewardCoins: number;
  createdAt: string;
  expiresAt: string;
};

export type AuctionState = {
  id: string;
  chatId: number;
  messageId: number;
  prizeCoins: number;
  currentPrice: number;
  highestBidderId: number | null;
  highestBidderUsername: string | null;
  highestBidderFirstName: string | null;
  expiresAt: string;
};

export type BirthdayEventState = {
  id: string;
  birthdayUserId: number;
  birthdayUsername: string | null;
  birthdayFirstName: string | null;
  amount: number;
  birthdayDay: string;
  messageId: number;
  expiresAt: string;
};

export type WebAppUser = {
  id: number;
  username?: string;
  first_name?: string;
};

export type ValidatedInitData = {
  authDate: number;
  raw: string;
  user: WebAppUser;
};
