// Small HTTP toolkit: routing, the response envelope, caching and errors.

export interface Meta {
  as_of_block: number | null;
  as_of_time: string | null;
  generated_at: string;
  ingest_lag_blocks: number | null;
  def_versions?: Record<string, number>;
  [k: string]: unknown;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (code: string, message: string) => new HttpError(400, code, message);
export const notFound = (message = "not found") => new HttpError(404, "not_found", message);

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, if-none-match",
  "access-control-max-age": "86400",
};

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function etagOf(text: string): string {
  // FNV-1a 32-bit, enough to detect change.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `W/"${(h >>> 0).toString(16)}-${text.length.toString(16)}"`;
}

export function json(request: Request, body: unknown, maxAge: number, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  const etag = etagOf(text);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": maxAge > 0 ? `public, max-age=${Math.min(maxAge, 60)}, s-maxage=${maxAge}` : "no-store",
    etag,
    ...CORS,
    ...SECURITY,
    ...extraHeaders,
  };
  if (status === 200 && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(text, { status, headers });
}

export function errorResponse(request: Request, e: unknown): Response {
  if (e instanceof HttpError) return json(request, { error: { code: e.code, message: e.message } }, 0, e.status);
  console.log(JSON.stringify({ msg: "api_error", path: new URL(request.url).pathname, error: String((e as Error)?.stack ?? e) }));
  return json(request, { error: { code: "internal", message: "internal error" } }, 0, 500);
}

export type Handler<E> = (ctx: RouteCtx<E>) => Promise<Response>;

export interface RouteCtx<E> {
  request: Request;
  env: E;
  url: URL;
  params: Record<string, string>;
  exec: ExecutionContext;
}

export interface Route<E> {
  method: string;
  pattern: string;
  re: RegExp;
  keys: string[];
  handler: Handler<E>;
  cache: number; // seconds, 0 = never cached
  admin: boolean;
  doc: { summary: string; query?: Record<string, string>; body?: Record<string, string> };
}

export class Router<E> {
  routes: Route<E>[] = [];
  add(method: string, pattern: string, cache: number, doc: Route<E>["doc"], handler: Handler<E>, admin = false) {
    const keys: string[] = [];
    const re = new RegExp(
      "^" + pattern.replace(/\{(\w+)\}/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$",
    );
    this.routes.push({ method, pattern, re, keys, handler, cache, admin, doc });
  }
  match(method: string, path: string): { route: Route<E>; params: Record<string, string> } | { allowed: string[] } | null {
    const allowed: string[] = [];
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) {
        allowed.push(r.method);
        continue;
      }
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return allowed.length ? { allowed } : null;
  }
}

export function intArg(url: URL, name: string, def: number, min: number, max: number): number {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw bad("bad_param", `${name} must be an integer`);
  return Math.max(min, Math.min(max, n));
}

export function enumArg<T extends string>(url: URL, name: string, allowed: readonly T[], def: T): T {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return def;
  if (!(allowed as readonly string[]).includes(v)) throw bad("bad_param", `${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

export async function readJson<T>(request: Request): Promise<T> {
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > 64 * 1024) throw new HttpError(413, "too_large", "body over 64 KB");
  try {
    return (await request.json()) as T;
  } catch {
    throw bad("bad_json", "body must be JSON");
  }
}
