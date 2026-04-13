import express, { type NextFunction, type Request, type Response } from "express";

import { handleAdAttempt } from "./api/ad-attempt";
import { handleAdDone } from "./api/ad-done";
import { handleAdminAction } from "./api/admin-action";
import { handleCloseRaffle } from "./api/close-raffle";
import { handleCreateRaffle } from "./api/create-raffle";
import { handleMonetagPostback } from "./api/monetag-postback";
import { handleMonetagSdk } from "./api/monetag-sdk";
import { handlePostHome } from "./api/post-home";
import { handleSetupWebhook } from "./api/setup-webhook";
import { handleWebAppSession } from "./api/webapp-session";
import { handleAdWebApp } from "./api/webapp";
import { sql } from "./db/postgres";
import { handleTelegramWebhook } from "./bot/webhook";

type CompatibleHandler = (req: any, res: any) => Promise<void>;

function wrap(handler: CompatibleHandler) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req as any, res as any);
    } catch (error) {
      next(error);
    }
  };
}

export function createServerApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "la-esquina-mvp",
      runtime: "railway"
    });
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "la-esquina-mvp"
    });
  });

  app.all("/api/webhook", wrap(handleTelegramWebhook));
  app.get("/api/webapp", wrap(handleAdWebApp));
  app.post("/api/webapp-session", wrap(handleWebAppSession));
  app.post("/api/ad-attempt", wrap(handleAdAttempt));
  app.post("/api/ad-done", wrap(handleAdDone));
  app.all("/api/monetag-postback", wrap(handleMonetagPostback));
  app.get("/api/monetag-sdk", wrap(handleMonetagSdk));
  app.post("/api/admin", wrap(handleAdminAction));
  app.post("/api/setup-webhook", wrap(handleSetupWebhook));
  app.post("/api/admin/post-home", wrap(handlePostHome));
  app.post("/api/admin/create-raffle", wrap(handleCreateRaffle));
  app.post("/api/admin/close-raffle", wrap(handleCloseRaffle));

  app.use((_req, res) => {
    res.status(404).json({
      ok: false,
      error: "Not found"
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("http_server_error", error);
    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      ok: false,
      error: "Internal server error"
    });
  });

  return app;
}

async function main(): Promise<void> {
  const app = createServerApp();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const host = "0.0.0.0";
  const server = app.listen(port, host, () => {
    console.log(`la-esquina-mvp listening on ${host}:${port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`received ${signal}, shutting down`);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (require.main === module) {
  void main();
}
