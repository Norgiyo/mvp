import type { RequestLike } from "../http/types";

import { env } from "../config";
import { matchesAnySecret } from "./secrets";

function readHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : null;
  }

  return null;
}

function bearerToken(req: RequestLike): string | null {
  const authorization = readHeaderValue(req.headers.authorization);
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}

export function isAdminRequest(req: RequestLike): boolean {
  const headerSecret = readHeaderValue(req.headers["x-admin-secret"]);
  return (
    matchesAnySecret(bearerToken(req), env.adminSecrets) ||
    matchesAnySecret(headerSecret, env.adminSecrets)
  );
}
