import { env } from "../config";
import { redis } from "../db/redis";

type IdleEventKind = "ad" | "drop";

const idleEventKinds: IdleEventKind[] = ["ad", "drop"];

function activityKey(): string {
  return `activity:group:${env.groupChatId}:last_seen_ms`;
}

function idleEventCursorKey(): string {
  return `activity:group:${env.groupChatId}:idle_event_rr`;
}

function lastIdleEventKey(): string {
  return `activity:group:${env.groupChatId}:last_idle_event`;
}

export async function markGroupActivity(date: Date = new Date()): Promise<void> {
  await redis.set(activityKey(), String(date.getTime()), { ex: 60 * 60 * 24 * 7 });
}

async function getLastStoredGroupActivityMs(): Promise<number | null> {
  const value = await redis.get<string>(activityKey());
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getLastGroupActivityMs(): Promise<number | null> {
  const cached = await getLastStoredGroupActivityMs();
  if (cached) {
    return cached;
  }

  return null;
}

export async function getGroupInactivitySeconds(): Promise<number> {
  const lastActivityMs = await getLastGroupActivityMs();
  if (!lastActivityMs) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Math.max(0, Math.floor((Date.now() - lastActivityMs) / 1000));
}

export async function canPostIdleEvent(): Promise<boolean> {
  const inactivity = await getGroupInactivitySeconds();
  if (inactivity < env.idleEventInactivitySeconds) {
    return false;
  }

  const ttl = await redis.ttl(lastIdleEventKey());
  return !(typeof ttl === "number" && ttl > 0);
}

export async function markIdleEventPosted(kind: IdleEventKind): Promise<void> {
  await redis.set(lastIdleEventKey(), kind, {
    ex: env.idleEventGlobalCooldownSeconds
  });
}

export async function getNextIdleEventKinds(): Promise<IdleEventKind[]> {
  const cursor = await redis.incr(idleEventCursorKey());
  const start = (cursor - 1) % idleEventKinds.length;

  return idleEventKinds.map((_, index) => idleEventKinds[(start + index) % idleEventKinds.length]!);
}
