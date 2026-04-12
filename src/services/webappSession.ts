import crypto from "node:crypto";

import { env } from "../config";
import { redis } from "../db/redis";

type WebAppSessionState = {
  userId: number;
};

function webAppSessionKey(token: string): string {
  return `webapp:session:${token}`;
}

export async function createWebAppSession(userId: number): Promise<{
  token: string;
  expiresAt: string;
}> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.webAppSessionTtlSeconds * 1000).toISOString();

  await redis.set(
    webAppSessionKey(token),
    { userId } satisfies WebAppSessionState,
    { ex: env.webAppSessionTtlSeconds }
  );

  return { token, expiresAt };
}

export async function getWebAppSessionUserId(token: string | null | undefined): Promise<number | null> {
  if (!token) {
    return null;
  }

  const state = await redis.get<WebAppSessionState>(webAppSessionKey(token));
  if (!state || !Number.isFinite(state.userId)) {
    return null;
  }

  return Number(state.userId);
}
