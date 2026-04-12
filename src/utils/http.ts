import type { ResponseLike } from "../http/types";

export function json(res: ResponseLike, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

export function text(res: ResponseLike, status: number, body: string): void {
  res.status(status).setHeader("content-type", "text/plain; charset=utf-8").send(body);
}

export function html(res: ResponseLike, status: number, body: string): void {
  res
    .status(status)
    .setHeader("content-type", "text/html; charset=utf-8")
    .setHeader("cache-control", "no-store, max-age=0")
    .send(body);
}
