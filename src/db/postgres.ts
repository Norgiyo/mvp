import postgres from "postgres";

import { env } from "../config";

export const sql = postgres(env.supabaseDbUrl, {
  ssl: "require",
  max: env.supabaseDbPoolMax,
  prepare: false,
  idle_timeout: 5,
  connect_timeout: 10
});
