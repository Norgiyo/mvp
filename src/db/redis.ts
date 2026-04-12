import { Redis } from "@upstash/redis";

import { env } from "../config";

export const redis = new Redis({
  url: env.upstashRedisRestUrl,
  token: env.upstashRedisRestToken
});
