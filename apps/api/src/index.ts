// tower-api: the public, read-only /v1 API, plus admin routes behind Cloudflare Access.
import { openapi } from "./openapi";
import { CORS, errorResponse, json } from "./http";
import { buildRouter, meta, type ApiEnv } from "./routes";

const router = buildRouter();

export default {
  async fetch(request: Request, env: ApiEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if (url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/") {
        return json(request, {
          data: { name: "Pixa Tower API", openapi: "/v1/openapi.json", metrics: "/v1/metrics", overview: "/v1/overview", status: "/v1/status" },
          meta: await meta(env),
        }, 300);
      }
      if (url.pathname === "/v1/openapi.json") {
        return json(request, openapi(router.routes as never, env.PUBLIC_BASE_URL ?? ""), 3600);
      }

      const m = router.match(request.method, url.pathname);
      if (!m) return json(request, { error: { code: "not_found", message: "no such route; see /v1/openapi.json" } }, 0, 404);
      if ("allowed" in m) {
        return json(request, { error: { code: "method_not_allowed", message: `use ${m.allowed.join(", ")}` } }, 0, 405, { allow: m.allowed.join(", ") });
      }
      const { route, params } = m;

      // Rate limit public routes per client IP (binding optional; a WAF rule can do the same).
      if (!route.admin && env.RATE_LIMITER) {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) return json(request, { error: { code: "rate_limited", message: "120 requests per minute per IP" } }, 0, 429, { "retry-after": "60" });
      }

      // Edge cache for public GETs.
      const cacheable = !route.admin && request.method === "GET" && route.cache > 0;
      const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      if (cacheable && cache) {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const etag = hit.headers.get("etag");
          if (etag && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: hit.headers });
          return hit;
        }
      }

      let res = await route.handler({ request, env, url, params, exec: ctx });

      // Stale data is still served, flagged, when ingestion lag is red.
      if (cacheable && res.status === 200) {
        const lag = Number((await res.clone().json().catch(() => ({})) as { meta?: { ingest_lag_blocks?: number } }).meta?.ingest_lag_blocks ?? 0);
        if (lag > Number(env.STALE_RED_BLOCKS ?? 1200)) {
          res = new Response(res.body, res);
          res.headers.set("x-tower-stale", "1");
          res.headers.set("cache-control", "public, max-age=5, s-maxage=5");
        }
        if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
      }
      return res;
    } catch (e) {
      return errorResponse(request, e);
    }
  },
};
