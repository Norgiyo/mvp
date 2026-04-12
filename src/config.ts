function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Env var ${name} must be an integer`);
  }
  return parsed;
}

function intEnvAlias(names: string[], fallback: number): number {
  for (const name of names) {
    const value = process.env[name];
    if (!value) {
      continue;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`Env var ${name} must be an integer`);
    }
    return parsed;
  }

  return fallback;
}



function optionalCsvEnv(name: string): string[] {
  const value = process.env[name];
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalIntCsvEnv(name: string): number[] {
  return optionalCsvEnv(name)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
}

function csvEnv(name: string, fallback?: string[]): string[] {
  const value = process.env[name];
  if (!value) {
    if (fallback && fallback.length > 0) {
      return fallback;
    }
    throw new Error(`Missing required env var: ${name}`);
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (parsed.length === 0) {
    throw new Error(`Env var ${name} must contain at least one value`);
  }

  return parsed;
}

const monetagZonePool = csvEnv(
  "MONETAG_MAIN_ZONE_IDS",
  process.env.MONETAG_MAIN_ZONE_ID ? [process.env.MONETAG_MAIN_ZONE_ID] : undefined
);
const telegramWebhookSecrets = [
  requireEnv("TELEGRAM_WEBHOOK_SECRET"),
  ...optionalCsvEnv("TELEGRAM_WEBHOOK_SECRET_PREVIOUS")
];
const adminSecrets = [
  requireEnv("ADMIN_SECRET"),
  ...optionalCsvEnv("ADMIN_SECRET_PREVIOUS")
];
const monetagPostbackSecrets = [
  requireEnv("MONETAG_POSTBACK_SECRET"),
  ...optionalCsvEnv("MONETAG_POSTBACK_SECRET_PREVIOUS")
];
const adDailyLimit = intEnv("AD_DAILY_LIMIT", 25);
const webAppInitDataMaxAgeSeconds = intEnv("WEBAPP_INITDATA_MAX_AGE_SECONDS", 60 * 15);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  appUrl: requireEnv("APP_URL").replace(/\/+$/, ""),
  botToken: requireEnv("BOT_TOKEN"),
  botUsername: requireEnv("BOT_USERNAME").replace(/^@/, ""),
  telegramWebhookSecret: telegramWebhookSecrets[0],
  telegramWebhookSecrets,
  adminSecret: adminSecrets[0],
  adminSecrets,
  supabaseDbUrl: requireEnv("SUPABASE_DB_URL"),
  supabaseDbPoolMax: intEnv("SUPABASE_DB_POOL_MAX", 5),
  upstashRedisRestUrl: requireEnv("UPSTASH_REDIS_REST_URL"),
  upstashRedisRestToken: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  monetagMainZoneId: monetagZonePool[0],
  monetagMainZoneIds: monetagZonePool,
  monetagSdkUrl: requireEnv("MONETAG_SDK_URL"),
  monetagPostbackSecret: monetagPostbackSecrets[0],
  monetagPostbackSecrets,
  monetagRequestVar: process.env.MONETAG_REQUEST_VAR ?? "rewarded_ad",
  adminTelegramIds: optionalIntCsvEnv("ADMIN_TELEGRAM_IDS"),
  groupChatId: intEnvAlias(["GROUP_CHANNEL_ID", "GROUP_CHAT_ID"], 0),
  adRewardCoins: intEnv("AD_REWARD_COINS", 50),
  adDailyLimit,
  adThrottleAfterCount: intEnv("AD_THROTTLE_AFTER_COUNT", 5),
  adThrottleCooldownSeconds: intEnv("AD_THROTTLE_COOLDOWN_SECONDS", 60 * 15),
  dailyRewardCoins: intEnv("DAILY_REWARD_COINS", 25),
  weeklyLeaderboardBonusCoins: intEnv("WEEKLY_LEADERBOARD_BONUS_COINS", 500),
  birthdayGiftCoins: intEnv("BIRTHDAY_GIFT_COINS", 10),

  adEventCooldownSeconds: intEnv("AD_EVENT_COOLDOWN_SECONDS", 60 * 60 * 4),
  luckyDropEventCooldownSeconds: intEnv("LUCKY_DROP_EVENT_COOLDOWN_SECONDS", 60 * 60),
  idleEventInactivitySeconds: intEnv("IDLE_EVENT_INACTIVITY_SECONDS", 60 * 60),
  idleEventGlobalCooldownSeconds: intEnv("IDLE_EVENT_GLOBAL_COOLDOWN_SECONDS", 60 * 45),
  luckyDropRewardCoins: intEnv("LUCKY_DROP_REWARD_COINS", 35),
  webAppInitDataMaxAgeSeconds,
  webAppSessionTtlSeconds: intEnv("WEBAPP_SESSION_TTL_SECONDS", 60 * 10)
};

export const appConfig = {
  allowedUpdates: ["message", "callback_query"] as const,
  adEventTtlSeconds: 60 * 60 * 6,
  adClaimTtlSeconds: 60 * 20,
  adAttemptPollMaxTries: 20,
  adAttemptPollIntervalMs: 3000,
  callbackWindowSeconds: 10,
  callbackBurstLimit: 8,
  dropTtlSeconds: 60 * 15,
  auctionInitialSeconds: 60 * 12,
  auctionBidResetSeconds: 60 * 2,
  birthdayEventRetentionTtlSeconds: 60 * 60 * 48,
  raffleDefaultDurationHours: 24
};
