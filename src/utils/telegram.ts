import type { TelegramProfile } from "../types";

export function toTelegramProfile(user: {
  id: number;
  username?: string | null;
  first_name?: string | null;
}): TelegramProfile {
  return {
    id: Number(user.id),
    username: user.username ?? null,
    first_name: user.first_name ?? null
  };
}

export function getStartPayload(text: string | undefined): string | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("/start")) {
    return null;
  }

  const [, payload] = trimmed.split(/\s+/, 2);
  return payload ?? null;
}
