export type QueryValue = string | string[] | undefined;

export type RequestLike = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query: Record<string, QueryValue>;
  params?: Record<string, string | undefined>;
};

export type ResponseLike = {
  status(code: number): ResponseLike;
  json(payload: unknown): unknown;
  send(body: string): unknown;
  setHeader(name: string, value: string): ResponseLike;
};
