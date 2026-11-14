import type {AccessClaims, AccessState, DeviceIdentity, MarketConfig} from './types';

export interface AccessRuntime {
  getAccess(): AccessState | null;
  getIdentity(): Promise<DeviceIdentity>;
  signChallenge(value: string): Promise<string>;
  now?(): number;
  subscribe(listener: () => void): () => void;
}
const encoder = new TextEncoder();
export function encodeBase64Url(bytes: Uint8Array): string {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid access proof encoding.');
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(text, char => char.charCodeAt(0));
}
export async function keyThumbprint(key: JsonWebKey): Promise<string> {
  if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || key.d) throw new Error('Unsupported installation key.');
  const canonical = JSON.stringify({crv: key.crv, kty: key.kty, x: key.x, y: key.y});
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical))));
}
/** Only the locally configured issuer key is trusted; peers cannot supply it. JWT times are seconds. */
export async function verifyAccessProof(proof: string, config: Pick<MarketConfig, 'issuer' | 'publicKey'>, nowMs = Date.now()): Promise<AccessClaims> {
  if (!config.publicKey || typeof proof !== 'string' || proof.length > 8192) throw new Error('A verified access issuer is unavailable.');
  const parts = proof.split('.'); if (parts.length !== 3) throw new Error('Invalid signed access proof.');
  const parse = (part: string) => JSON.parse(new TextDecoder().decode(decodeBase64Url(part)));
  const header = parse(parts[0]);
  if (header.alg !== 'ES256' || header.typ !== 'JWT' || header.crit) throw new Error('Unsupported access signature.');
  const key = await crypto.subtle.importKey('jwk', config.publicKey, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
  const signature = decodeBase64Url(parts[2]);
  if (signature.length !== 64 || !await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, signature, encoder.encode(`${parts[0]}.${parts[1]}`))) throw new Error('Invalid access signature.');
  const claims = parse(parts[1]) as AccessClaims;
  if (claims.iss !== config.issuer || claims.v !== 1 || !['ad', 'grace', 'paid'].includes(claims.kind) || typeof claims.installationId !== 'string' || claims.installationId.length > 128 || !claims.installationId || typeof claims.keyThumbprint !== 'string' || claims.keyThumbprint.length !== 43 || typeof claims.hyperSpeed !== 'boolean' || claims.hyperSpeed !== (claims.kind === 'paid') || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat || claims.iat * 1000 > nowMs + 60_000 || claims.exp * 1000 <= nowMs || claims.exp * 1000 - claims.iat * 1000 > 24 * 60 * 60_000 + 1000) throw new Error('Access expired or contains invalid claims. Renew access on the other device.');
  if (claims.kind === 'paid' && (!Number.isSafeInteger(claims.paidUntil) || claims.paidUntil! < claims.exp * 1000)) throw new Error('Invalid paid entitlement expiry.');
  return claims;
}
export interface PeerAccessProof {proof: string; device: DeviceIdentity; signature: string; challenge: string;}
export function peerChallengeText(sessionId: string, revision: number, challenge: string, proof: string): string {
  return JSON.stringify({purpose: 'fileshareica-peer-access-v1', sessionId, revision, challenge, proof});
}
export async function verifyPeerAccess(value: PeerAccessProof, config: Pick<MarketConfig, 'issuer' | 'publicKey'>, expected: {sessionId: string; revision: number; challenge: string; nowMs: number}): Promise<AccessClaims> {
  if (value.challenge !== expected.challenge || !value.device || !['desktop', 'mobile'].includes(value.device.deviceClass) || typeof value.signature !== 'string') throw new Error('Access proof does not match this connection.');
  const claims = await verifyAccessProof(value.proof, config, expected.nowMs);
  if (claims.installationId !== value.device.installationId || claims.keyThumbprint !== await keyThumbprint(value.device.publicKey)) throw new Error('Access belongs to another installation.');
  const key = await crypto.subtle.importKey('jwk', value.device.publicKey, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
  const signature = decodeBase64Url(value.signature);
  if (signature.length !== 64 || !await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, signature, encoder.encode(peerChallengeText(expected.sessionId, expected.revision, expected.challenge, value.proof)))) throw new Error('Installation ownership could not be verified.');
  return claims;
}
