import type {DeviceIdentity, MarketConfig} from './types';
import {decodeBase64Url, keyThumbprint} from './proofs';
import {digestSendManifest, type SendIntent, type SendPermit} from './send-types';
import {MAX_BATCH_FILES, isValidFileSize} from '../transfer-policy';

export interface SendEnvelope {intent: SendIntent; permit: SendPermit; device: DeviceIdentity; signature: string;}
const encoder = new TextEncoder();
export function sendEnvelopeText(roomId: string, revision: number, recipientId: string, intent: SendIntent, permit: SendPermit): string {
  return JSON.stringify({purpose: 'fileshareica-send-v2', roomId, revision, recipientId, intent, permit});
}
export async function validateSendPermit(intent: SendIntent, permit: SendPermit, config: Pick<MarketConfig, 'issuer' | 'publicKey'> | null, nowMs: number, device?: DeviceIdentity): Promise<void> {
  if (!intent || !permit || permit.policyVersion !== 2 || permit.operationId !== intent.operationId || permit.sessionId !== intent.sessionId || permit.manifestDigest !== intent.manifestDigest || !Array.isArray(intent.files) || !intent.files.length || intent.files.length > MAX_BATCH_FILES || !Array.isArray(intent.recipientIds) || !intent.recipientIds.length || intent.recipientIds.length > 7 || new Set(intent.recipientIds).size !== intent.recipientIds.length || !Array.isArray(permit.recipientIds) || JSON.stringify([...permit.recipientIds].sort()) !== JSON.stringify([...intent.recipientIds].sort()) || typeof permit.senderInstallationId !== 'string' || !permit.senderInstallationId || !['premium', 'credit', 'ad_completed', 'no_fill', 'offline'].includes(permit.decision) || !Number.isSafeInteger(permit.issuedAt) || !Number.isSafeInteger(permit.expiresAt) || permit.issuedAt > nowMs + 60_000 || permit.expiresAt <= nowMs || permit.expiresAt <= permit.issuedAt || permit.expiresAt - permit.issuedAt > 24 * 60 * 60_000 || await digestSendManifest(intent) !== intent.manifestDigest) throw new Error('The send authorization does not match this file selection. Try Send again.');
  const ids = new Set<string>();
  for (const file of intent.files) {if (!file || typeof file.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(file.id) || ids.has(file.id) || !isValidFileSize(file.size)) throw new Error('Invalid authorized file manifest.'); ids.add(file.id);}
  if (device && device.installationId !== permit.senderInstallationId) throw new Error('The send authorization belongs to a different installation.');
  if (permit.decision === 'offline' && permit.proof === null) return; // Best-effort offline accounting, never paid-speed authority.
  if (!config?.publicKey || typeof permit.proof !== 'string' || permit.proof.length > 20_000) throw new Error('A verified online send authorization is required.');
  const parts = permit.proof.split('.'); if (parts.length !== 3) throw new Error('Invalid signed send authorization.');
  const parse = (value: string) => JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  const header = parse(parts[0]);
  if (header.alg !== 'ES256' || header.typ !== 'JWT' || header.crit) throw new Error('Unsupported send signature.');
  const key = await crypto.subtle.importKey('jwk', config.publicKey, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
  const signature = decodeBase64Url(parts[2]);
  if (signature.length !== 64 || !await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, signature, encoder.encode(`${parts[0]}.${parts[1]}`))) throw new Error('Invalid send signature.');
  const claims = parse(parts[1]);
  if (claims.iss !== config.issuer || claims.v !== 2 || claims.purpose !== 'send' || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat !== Math.floor(permit.issuedAt / 1000) || claims.exp !== Math.floor(permit.expiresAt / 1000) || claims.exp * 1000 <= nowMs) throw new Error('The send authorization expired or uses another issuer.');
  const {proof: _proof, ...outer} = permit; void _proof;
  for (const [name, expected] of Object.entries(outer)) if (JSON.stringify(claims[name]) !== JSON.stringify(expected)) throw new Error('The signed send authorization was changed.');
  if (device && claims.senderKeyThumbprint !== await keyThumbprint(device.publicKey)) throw new Error('The send authorization belongs to a different installation key.');
}
export async function verifySendEnvelope(envelope: SendEnvelope, expected: {roomId: string; revision: number; sessionId: string; recipientId: string; files: {id: string; size: number}[]; nowMs: number}, config: Pick<MarketConfig, 'issuer' | 'publicKey'> | null): Promise<void> {
  if (!envelope?.device || !envelope.intent || typeof envelope.signature !== 'string' || envelope.intent.sessionId !== expected.sessionId || !Array.isArray(envelope.intent.recipientIds) || !envelope.intent.recipientIds.includes(expected.recipientId) || !Array.isArray(envelope.intent.files) || !expected.files.length || expected.files.length > MAX_BATCH_FILES || new Set(expected.files.map(file => file.id)).size !== expected.files.length || expected.files.some(file => !isValidFileSize(file.size) || !envelope.intent.files.some(authorized => authorized.id === file.id && authorized.size === file.size))) throw new Error('This send authorization does not include these files or this recipient.');
  await validateSendPermit(envelope.intent, envelope.permit, config, expected.nowMs, envelope.device);
  const key = await crypto.subtle.importKey('jwk', envelope.device.publicKey, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
  const signature = decodeBase64Url(envelope.signature);
  if (signature.length !== 64 || !await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, signature, encoder.encode(sendEnvelopeText(expected.roomId, expected.revision, expected.recipientId, envelope.intent, envelope.permit)))) throw new Error('The sending installation could not be verified.');
}
