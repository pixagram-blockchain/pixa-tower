// OpenAPI 3.1 document generated from the route table, so it can never drift from the code.
import type { Route } from "./http";

export function openapi(routes: Route<unknown>[], baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const params = [
      ...r.keys.map((k) => ({ name: k, in: "path", required: true, schema: { type: "string" } })),
      ...Object.entries(r.doc.query ?? {}).map(([name, description]) => ({ name, in: "query", required: false, description, schema: { type: "string" } })),
    ];
    (paths[r.pattern] ??= {})[r.method.toLowerCase()] = {
      summary: r.doc.summary,
      tags: [r.admin ? "admin" : r.pattern.split("/")[2]],
      ...(params.length ? { parameters: params } : {}),
      ...(r.doc.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(Object.entries(r.doc.body).map(([k, d]) => [k, { description: d }])) } } },
            },
          }
        : {}),
      ...(r.admin ? { security: [{ cloudflareAccess: [] }] } : {}),
      responses: {
        "200": { description: "Envelope: { data, meta: { as_of_block, as_of_time, generated_at, ingest_lag_blocks } }" },
        "304": { description: "Not modified (If-None-Match)" },
        "400": { description: "{ error: { code, message } }" },
        ...(r.admin ? { "401": { description: "No valid Cloudflare Access identity" } } : {}),
        "404": { description: "Not found" },
        "429": { description: "Rate limited" },
      },
      ...(r.cache ? { "x-cache-seconds": r.cache } : {}),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Pixa Tower API",
      version: "1.0.0",
      description:
        "Read-only statistics, governance and alert data for the Pixa chain. Every figure comes from hived operations scanned block by block; Hivemind is used only for community titles. Amounts are in units (PIXA, PXS, VESTS) unless a field says otherwise.",
    },
    servers: [{ url: baseUrl || "/" }],
    components: {
      securitySchemes: { cloudflareAccess: { type: "apiKey", in: "header", name: "Cf-Access-Jwt-Assertion", description: "Set by Cloudflare Access" } },
    },
    paths,
  };
}
