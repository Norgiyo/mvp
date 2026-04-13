import type { RequestLike, ResponseLike } from "../http/types";

import { env } from "../config";
import { processMonetagPostback } from "../services/ads";
import type { MonetagPostbackPayload } from "../types";
import { json } from "../utils/http";
import { matchesAnySecret } from "../utils/secrets";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFirstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = readString(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  return readString(value);
}

function readSourceValue(source: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = readFirstString(source[name]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function normalizeRewardEventType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.trim().toLowerCase().replace(/-/g, "_");
}

function readBody(req: RequestLike): Record<string, unknown> {
  if (typeof req.body === "string") {
    return JSON.parse(req.body) as Record<string, unknown>;
  }

  if (req.body && typeof req.body === "object") {
    return req.body as Record<string, unknown>;
  }

  return {};
}

function readPayload(req: RequestLike): MonetagPostbackPayload {
  const body = readBody(req);
  const source = {
    ...(req.query ?? {}),
    ...(body ?? {})
  };

  return {
    ymid: readSourceValue(source, "ymid") ?? "",
    event_type: readSourceValue(source, "event_type", "event"),
    reward_event_type: normalizeRewardEventType(
      readSourceValue(source, "reward_event_type", "reward")
    ),
    estimated_price: readSourceValue(source, "estimated_price", "price", "revenue"),
    zone_id: readSourceValue(source, "zone_id", "zone"),
    sub_zone_id: readSourceValue(source, "sub_zone_id", "sub_zone"),
    request_var: readSourceValue(source, "request_var", "requestVar", "source"),
    telegram_id: readSourceValue(source, "telegram_id", "telegramId")
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDigits(value: string | undefined): boolean {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function validatePayload(payload: MonetagPostbackPayload): string | null {
  if (!payload.ymid || !isUuid(payload.ymid)) {
    return "Invalid ymid";
  }

  if (!payload.zone_id || !isDigits(payload.zone_id)) {
    return "Invalid zone_id";
  }

  if (payload.sub_zone_id && !isDigits(payload.sub_zone_id)) {
    return "Invalid sub_zone_id";
  }

  if (payload.telegram_id && !isDigits(payload.telegram_id)) {
    return "Invalid telegram_id";
  }

  if (
    payload.reward_event_type &&
    payload.reward_event_type !== "valued" &&
    payload.reward_event_type !== "not_valued" &&
    payload.reward_event_type !== "non_valued"
  ) {
    return "Invalid reward_event_type";
  }

  if (
    payload.estimated_price &&
    !/^\d+(\.\d+)?$/.test(payload.estimated_price)
  ) {
    return "Invalid estimated_price";
  }

  return null;
}

export async function handleMonetagPostback(
  req: RequestLike,
  res: ResponseLike
): Promise<void> {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      json(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    const secret =
      readFirstString(req.headers["x-monetag-secret"]) ??
      readFirstString(req.query.secret) ??
      readFirstString(readBody(req).secret);

    if (!matchesAnySecret(secret, env.monetagPostbackSecrets)) {
      console.warn("monetag_postback_invalid_secret", {
        method: req.method,
        hasHeaderSecret: Boolean(readFirstString(req.headers["x-monetag-secret"])),
        hasQuerySecret: Boolean(readFirstString(req.query.secret)),
        hasBodySecret: Boolean(readFirstString(readBody(req).secret))
      });
      json(res, 403, { ok: false, error: "Invalid postback secret" });
      return;
    }

    const payload = readPayload(req);
    const payloadError = validatePayload(payload);
    if (payloadError) {
      console.warn("monetag_postback_invalid_payload", {
        error: payloadError,
        ymid: payload.ymid,
        zone_id: payload.zone_id ?? null,
        telegram_id: payload.telegram_id ?? null,
        request_var: payload.request_var ?? null,
        reward_event_type: payload.reward_event_type ?? null
      });
      json(res, 400, { ok: false, error: payloadError });
      return;
    }

    const result = await processMonetagPostback(payload);
    console.info("monetag_postback_processed", {
      status: result.status,
      rewarded: "rewarded" in result ? result.rewarded : undefined,
      reason: "reason" in result ? result.reason : undefined,
      ymid: payload.ymid,
      zone_id: payload.zone_id ?? null,
      request_var: payload.request_var ?? null,
      reward_event_type: payload.reward_event_type ?? null,
      event_type: payload.event_type ?? null
    });
    json(res, 200, {
      ok: true,
      ...result
    });
  } catch (error) {
    console.error("monetag_postback_failed", error);
    json(res, 500, {
      ok: false,
      error: "Internal server error"
    });
  }
}
