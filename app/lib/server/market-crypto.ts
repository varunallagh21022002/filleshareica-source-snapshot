import type { AccessClaims, DeviceAssertion } from "../market/types";
import { ApiError } from "./policy";

const enc = new TextEncoder();
export const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ApiError(400, "Invalid encoded credential.");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
}
export async function thumbprint(key: JsonWebKey): Promise<string> {
  if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y || key.d || key.x.length !== 43 || key.y.length !== 43) throw new ApiError(400, "Use a public P-256 installation key.");
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })))));
}
export async function verifyAssertion(value: unknown, now: number): Promise<{ assertion: DeviceAssertion; thumbprint: string }> {
  const a = value as DeviceAssertion | undefined;
  if (!a || !a.device || typeof a.device.installationId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(a.device.installationId)
    || !["desktop", "mobile"].includes(a.device.deviceClass) || typeof a.device.label !== "string" || !a.device.label.trim() || a.device.label.length > 80
    || !Number.isSafeInteger(a.timestamp) || Math.abs(now - a.timestamp) > 5 * 60_000 || typeof a.nonce !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(a.nonce)
    || typeof a.signature !== "string" || a.signature.length > 200) throw new ApiError(401, "Refresh this page to refresh the installation proof.");
  try {
    const fingerprint = await thumbprint(a.device.publicKey);
    const key = await crypto.subtle.importKey("jwk", a.device.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const message = `fileshare-device-v1:${a.device.installationId}:${a.timestamp}:${a.nonce}`;
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unbase64url(a.signature), enc.encode(message))) throw new Error("signature");
    return { assertion: a, thumbprint: fingerprint };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "The installation proof is invalid.");
  }
}
export function publicSigningKey(raw: string | undefined): JsonWebKey | null {
  if (!raw) return null;
  try { const key = JSON.parse(raw) as JsonWebKey; return key.kty === "EC" && key.crv === "P-256" && key.x && key.y && key.d ? { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true } : null; } catch { return null; }
}
export async function signClaims(claims: AccessClaims, raw: string | undefined): Promise<string | null> {
  return signMarketPayload(claims, raw);
}
export async function signMarketPayload(claims: object, raw: string | undefined): Promise<string | null> {
  if (!raw || !publicSigningKey(raw)) return null;
  const key = await crypto.subtle.importKey("jwk", JSON.parse(raw), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const input = `${base64url(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT" })))}.${base64url(enc.encode(JSON.stringify(claims)))}`;
  return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input))))}`;
}

type GoogleClaims = { sub: string; email: string; name: string; email_verified: boolean; iss: string; aud: string | string[]; azp?: string; exp: number; iat: number };
let googleKeys: { keys: (JsonWebKey & { kid?: string })[]; until: number } | undefined;
export function clearGoogleKeyCache(): void { googleKeys = undefined; }
export async function verifyGoogleToken(token: unknown, clientId: string | undefined, now: number, fetcher: typeof fetch = fetch): Promise<GoogleClaims> {
  if (!clientId) throw new ApiError(503, "Google sign-in is not configured yet.");
  if (typeof token !== "string" || token.length > 20_000) throw new ApiError(401, "Google sign-in could not be verified.");
  try {
    const parts = token.split("."); if (parts.length !== 3) throw new Error("JWT");
    const header = JSON.parse(new TextDecoder().decode(unbase64url(parts[0]))) as { alg: string; kid: string };
    const claims = JSON.parse(new TextDecoder().decode(unbase64url(parts[1]))) as GoogleClaims;
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("algorithm");
    if (!googleKeys || googleKeys.until <= now || !googleKeys.keys.some(k => k.kid === header.kid)) {
      const response = await fetcher("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("keys");
      const body = await response.json() as { keys: JsonWebKey[] };
      if (!Array.isArray(body.keys) || body.keys.length > 20) throw new Error("keys");
      const seconds = Math.min(86_400, Math.max(60, Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1] ?? 3600)));
      googleKeys = { keys: body.keys, until: now + seconds * 1000 };
    }
    const jwk = googleKeys.keys.find(k => k.kid === header.kid);
    if (!jwk) throw new Error("key");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unbase64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`))) throw new Error("signature");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || !audiences.includes(clientId)
      || (claims.azp && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now || !Number.isFinite(claims.iat) || claims.iat * 1000 > now + 60_000
      || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || claims.email_verified !== true || typeof claims.email !== "string" || claims.email.length > 254) throw new Error("claims");
    return claims;
  } catch { throw new ApiError(401, "Google sign-in could not be verified. Please try again."); }
}

export async function verifyCashfreeSignature(raw: string, timestamp: string | null, signature: string | null, secret: string, now: number): Promise<void> {
  if (!timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 10 * 60_000 || !signature || signature.length > 100) throw new ApiError(401, "Invalid payment webhook signature.");
  try {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify("HMAC", key, bytes, enc.encode(timestamp + raw))) throw new Error("signature");
  } catch { throw new ApiError(401, "Invalid payment webhook signature."); }
}
