// Admin authentication: a Cloudflare Access JWT (SSO users and service tokens), verified here too,
// so a route left outside the Access policy by mistake still refuses the call.
// For local development only, ADMIN_TOKEN (a secret) can be sent as "Authorization: Bearer <token>".

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let certCache: { at: number; keys: Jwk[] } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function certs(teamDomain: string): Promise<Jwk[]> {
  if (certCache && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  certCache = { at: Date.now(), keys: body.keys };
  return body.keys;
}

export interface AdminIdentity {
  subject: string;
  via: "access" | "token";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyAdmin(
  request: Request,
  env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; ADMIN_TOKEN?: string },
): Promise<AdminIdentity | null> {
  const auth = request.headers.get("authorization");
  if (env.ADMIN_TOKEN && auth?.startsWith("Bearer ") && timingSafeEqual(auth.slice(7), env.ADMIN_TOKEN)) {
    return { subject: "admin-token", via: "token" };
  }
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { kid: string; alg: string };
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as { aud: string | string[]; exp: number; iss: string; email?: string; sub?: string; common_name?: string };
    if (header.alg !== "RS256") return null;
    const key = (await certs(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!key) return null;
    const cryptoKey = await crypto.subtle.importKey("jwk", key as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    return { subject: payload.email ?? payload.common_name ?? payload.sub ?? "access", via: "access" };
  } catch {
    return null;
  }
}
