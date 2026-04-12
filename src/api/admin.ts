import type { RequestLike, ResponseLike } from "../http/types";

import { json } from "../utils/http";
import { isAdminRequest } from "../utils/auth";

export function guardAdmin(req: RequestLike, res: ResponseLike): boolean {
  if (!isAdminRequest(req)) {
    json(res, 401, { ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}
