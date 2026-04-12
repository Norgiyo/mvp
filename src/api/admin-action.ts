import type { RequestLike, ResponseLike } from "../http/types";

import { handleCloseRaffle } from "./close-raffle";
import { handleCreateRaffle } from "./create-raffle";
import { handlePostHome } from "./post-home";
import { handleSetupWebhook } from "./setup-webhook";
import { json } from "../utils/http";

type AdminAction =
  | "setup_webhook"
  | "post_home"
  | "create_raffle"
  | "close_raffle";

function readAction(req: RequestLike): AdminAction | null {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  const action =
    typeof body.action === "string"
      ? body.action
      : typeof req.query.action === "string"
        ? req.query.action
        : null;

  switch (action) {
    case "setup_webhook":
    case "post_home":
    case "create_raffle":
    case "close_raffle":
      return action;
    default:
      return null;
  }
}

export async function handleAdminAction(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const action = readAction(req);
  if (!action) {
    json(res, 400, { ok: false, error: "Missing or invalid admin action" });
    return;
  }

  switch (action) {
    case "setup_webhook":
      await handleSetupWebhook(req, res);
      return;
    case "post_home":
      await handlePostHome(req, res);
      return;
    case "create_raffle":
      await handleCreateRaffle(req, res);
      return;
    case "close_raffle":
      await handleCloseRaffle(req, res);
      return;
  }
}
