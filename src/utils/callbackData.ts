import type { CallbackAction, CallbackPayload } from "../types";

export function encodeCallback(action: CallbackAction, value?: string): string {
  return value ? `${action}:${value}` : action;
}

export function decodeCallback(data: string | undefined): CallbackPayload | null {
  if (!data) {
    return null;
  }

  const [action, ...rest] = data.split(":");
  const allowed = new Set<CallbackAction>([
    "balance",
    "daily",
    "drop",
    "boost",
    "mining",
    "birthday",
    "auction",
    "raffle",
    "admin"
  ]);

  if (!allowed.has(action as CallbackAction)) {
    return null;
  }

  return {
    action: action as CallbackAction,
    value: rest.length > 0 ? rest.join(":") : undefined
  };
}
