import type { RequestLike, ResponseLike } from "../http/types";

import { env } from "../config";

const SCRIPT_CACHE_SECONDS = 60 * 10;

function normalizeSdkUrl(url: string): string {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== "https:") {
    throw new Error("Monetag SDK URL must use https");
  }
  return parsed.toString();
}

export async function handleMonetagSdk(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const sdkUrl = normalizeSdkUrl(env.monetagSdkUrl);
    const response = await fetch(sdkUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "la-esquina-mvp/1.0"
      }
    });

    if (!response.ok) {
      res.status(502).json({
        ok: false,
        error: `Monetag SDK upstream error (${response.status})`
      });
      return;
    }

    const script = await response.text();
    res.setHeader("content-type", "application/javascript; charset=utf-8");
    res.setHeader("cache-control", `public, max-age=${SCRIPT_CACHE_SECONDS}, s-maxage=${SCRIPT_CACHE_SECONDS}`);
    res.status(200).send(script);
  } catch (error) {
    console.error("monetag_sdk_proxy_failed", error);
    res.status(502).json({
      ok: false,
      error: "Failed to fetch Monetag SDK"
    });
  }
}
