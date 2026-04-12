import crypto from "node:crypto";

import { env } from "../config";
import type { ValidatedInitData, WebAppUser } from "../types";

function toBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function validateTelegramInitData(initData: string | undefined | null): ValidatedInitData {
  if (!initData) {
    throw new Error("initData is required");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    throw new Error("initData hash is missing");
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(env.botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const isValid =
    hash.length === computedHash.length &&
    crypto.timingSafeEqual(toBuffer(hash), toBuffer(computedHash));

  if (!isValid) {
    throw new Error("Invalid initData signature");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) {
    throw new Error("initData auth_date is invalid");
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > env.webAppInitDataMaxAgeSeconds) {
    throw new Error("initData is too old");
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new Error("initData user is missing");
  }

  const user = JSON.parse(userRaw) as WebAppUser;
  if (!user?.id) {
    throw new Error("initData user is invalid");
  }

  return {
    authDate,
    raw: initData,
    user
  };
}
