const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function toBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid invitation key.');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}
export function createInvitationSecret(): string { return toBase64Url(crypto.getRandomValues(new Uint8Array(32))); }
export async function invitationHash(secret: string): Promise<string> {
  const bytes = fromBase64Url(secret);
  if (bytes.length !== 32) throw new Error('Invalid invitation key.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function deriveSignalKey(secret: string, room: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(secret);
  if (bytes.length !== 32) throw new Error('Invalid invitation key.');
  const material = await crypto.subtle.importKey('raw', bytes as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(room), info: encoder.encode('f8il3shar33r-signaling-v1')}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
export interface SignalEnvelope { v: 1; sender: 'host' | 'guest'; generation: string; sequence: number; nonce: string; ciphertext: string }
const context = (room: string, envelope: Pick<SignalEnvelope, 'sender' | 'generation' | 'sequence'>) => encoder.encode(JSON.stringify(['f8-v1', room, envelope.sender, envelope.generation, envelope.sequence]));
export async function encryptSignal(key: CryptoKey, room: string, sender: SignalEnvelope['sender'], generation: string, sequence: number, message: unknown): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const envelope: SignalEnvelope = {v: 1, sender, generation, sequence, nonce: toBase64Url(nonce), ciphertext: ''};
  envelope.ciphertext = toBase64Url(new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: context(room, envelope)}, key, encoder.encode(JSON.stringify(message)))));
  return JSON.stringify(envelope);
}
export class SignalDecryptor {
  private seen = new Set<string>();
  constructor(private key: CryptoKey, private room: string, private ownRole: SignalEnvelope['sender']) {}
  async decrypt(payload: string): Promise<unknown> {
    if (payload.length > 150_000) throw new Error('Signaling message is too large.');
    const envelope = JSON.parse(payload) as SignalEnvelope;
    if (envelope.v !== 1 || !['host', 'guest'].includes(envelope.sender) || envelope.sender === this.ownRole || typeof envelope.generation !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(envelope.generation) || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0) throw new Error('Invalid signaling envelope.');
    const replayId = `${envelope.sender}:${envelope.generation}:${envelope.sequence}`;
    if (this.seen.has(replayId)) throw new Error('Repeated signaling message.');
    const nonce = fromBase64Url(envelope.nonce);
    if (nonce.length !== 12) throw new Error('Invalid signaling nonce.');
    const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: nonce as BufferSource, additionalData: context(this.room, envelope)}, this.key, fromBase64Url(envelope.ciphertext) as BufferSource);
    this.seen.add(replayId);
    if (this.seen.size > 2000) throw new Error('Signaling limit reached. Create a new session.');
    return JSON.parse(decoder.decode(plaintext));
  }
}
export function parseInvitation(value: string, origin: string): {sessionId: string; secret: string; group?: true} {
  let url: URL;
  try { url = new URL(value, origin); } catch { throw new Error('Paste a complete connection link.'); }
  if (url.origin !== origin) throw new Error('This link belongs to a different website. Open that website to join.');
  const named = /^\/s\/([a-z0-9-]{1,80})\/?$/.exec(url.pathname);
  const short = /^\/([a-f0-9]{6})\/?$/.exec(url.pathname);
  const sessionId = short?.[1] || named?.[1] || url.searchParams.get('session');
  const secret = new URLSearchParams(url.hash.slice(1)).get('key');
  if (!sessionId || (!short && !named && !/^[A-Za-z0-9_-]{12,128}$/.test(sessionId)) || !secret || fromBase64Url(secret).length !== 32) throw new Error('This invitation is incomplete. Copy the full link, including its key.');
  return {sessionId, secret, ...(new URLSearchParams(url.hash.slice(1)).get('group') === '1' ? {group: true as const} : {})};
}
