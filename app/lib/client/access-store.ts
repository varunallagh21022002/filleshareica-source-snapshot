import type { AccessState, DeviceAssertion, DeviceIdentity, MarketConfig } from '../market/types';
import { keyThumbprint, verifyAccessProof } from '../market/proofs';

export interface AccessSnapshot {
  access: AccessState | null;
  config: MarketConfig | null;
  loading: boolean;
  error: string | null;
  device: DeviceIdentity | null;
  verifiedOffline: boolean;
}
type StoredIdentity = { identity: DeviceIdentity; privateKey: CryptoKey };
const CACHE_KEY = 'f8-market-paid-lease-v1';
const DB_NAME = 'f8-device-identity-v1';
const STORE = 'keys';
const EMPTY: AccessSnapshot = { access: null, config: null, loading: false, error: null, device: null, verifiedOffline: false };
const encoder = new TextEncoder();

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let value = ''; for (const byte of array) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function deviceAssertionMessage(installationId: string, timestamp: number, nonce: string): string {
  return `fileshare-device-v1:${installationId}:${timestamp}:${nonce}`;
}
export function identifyDevice(userAgent: string): Pick<DeviceIdentity, 'deviceClass' | 'label'> {
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(userAgent);
  return { deviceClass: mobile ? 'mobile' : 'desktop', label: /iPhone|iPad|iPod/i.test(userAgent) ? 'Apple mobile browser' : /Android/i.test(userAgent) ? 'Android browser' : /Macintosh|Mac OS/i.test(userAgent) ? 'Mac browser' : /Windows/i.test(userAgent) ? 'Windows browser' : 'Desktop browser' };
}
/** Never take the signing key or entitlement fields from the localStorage lease blob. */
export async function restorePaidLease(access: AccessState, identity: DeviceIdentity, trustedConfig: MarketConfig | null, nowMs = Date.now()): Promise<AccessState | null> {
  if (!access.proof || !trustedConfig?.publicKey) return null;
  try {
    const claims = await verifyAccessProof(access.proof, trustedConfig, nowMs);
    if (claims.kind !== 'paid' || claims.installationId !== identity.installationId || claims.keyThumbprint !== await keyThumbprint(identity.publicKey) || claims.exp * 1000 > nowMs + 24 * 60 * 60_000 || !claims.paidUntil || claims.exp * 1000 > claims.paidUntil) return null;
    return { ...access, kind: 'paid', allowed: true, hyperSpeed: true, expiresAt: claims.exp * 1000, paidUntil: claims.paidUntil, serverNow: nowMs, account: null, orders: [], devices: [], deviceStatus: 'registered', config: trustedConfig };
  } catch { return null; }
}
async function openIdentityDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB || !crypto.subtle) throw new Error('This browser needs secure device storage. Open the site over HTTPS, or use localhost for development.');
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function readTrustedConfig(): Promise<MarketConfig | null> {
  const database = await openIdentityDatabase();
  try { return await new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get('network-market-config');
    request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
  }); } finally { database.close(); }
}
/** Trust is established only by a successful same-origin network response, never a lease cache. */
async function rememberNetworkConfig(config: MarketConfig): Promise<void> {
  if (typeof window === 'undefined' || location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  if (config.publicKey) {
    if (config.publicKey.d || config.publicKey.kty !== 'EC' || config.publicKey.crv !== 'P-256' || typeof config.issuer !== 'string') throw new Error('The access signing key is invalid.');
    await crypto.subtle.importKey('jwk', config.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  const database = await openIdentityDatabase();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    if (config.publicKey) transaction.objectStore(STORE).put(config, 'network-market-config');
    else transaction.objectStore(STORE).delete('network-market-config');
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  }); } finally { database.close(); }
}
async function deviceIdentity(): Promise<StoredIdentity> {
  const database = await openIdentityDatabase();
  try {
    const existing = await new Promise<StoredIdentity | undefined>((resolve, reject) => {
      const request = database.transaction(STORE).objectStore(STORE).get('installation');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (existing?.privateKey && existing.identity?.publicKey) return existing;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const ua = navigator.userAgent + ((navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ? ' iPad' : '');
    const stored: StoredIdentity = { identity: { installationId: crypto.randomUUID(), ...identifyDevice(ua), publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) }, privateKey: pair.privateKey };
    // add, rather than put: two first-load tabs must not overwrite each other's installation.
    return await new Promise<StoredIdentity>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const request = transaction.objectStore(STORE).add(stored, 'installation');
      request.onsuccess = () => { transaction.oncomplete = () => resolve(stored); };
      request.onerror = event => {
        if (request.error?.name !== 'ConstraintError') { reject(request.error); return; }
        event.preventDefault(); event.stopPropagation();
        const read = transaction.objectStore(STORE).get('installation');
        read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
      };
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

class AccessStore {
  private snapshot: AccessSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private identityPromise: Promise<StoredIdentity> | null = null;
  private initializing: Promise<void> | null = null;
  private refreshing: Promise<AccessState> | null = null;
  private leaseRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private clockAnchor: { server: number; local: number } | null = null;
  private broadcast: BroadcastChannel | null = null;
  private source = '';
  private seenMessages = new Set<string>();
  private peerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVisibilityRefresh = 0;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(next: Partial<AccessSnapshot>) { this.snapshot = { ...this.snapshot, ...next }; for (const listener of this.listeners) listener(); }
  private identity() { return this.identityPromise ||= deviceIdentity().catch(error => { this.identityPromise = null; throw error; }); }
  getIdentity = async () => (await this.identity()).identity;
  signPeerChallenge = async (challenge: string): Promise<string> => base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (await this.identity()).privateKey, encoder.encode(challenge)));
  sign = this.signPeerChallenge;
  assertion = async (): Promise<DeviceAssertion> => {
    const device = await this.getIdentity(); const timestamp = Date.now(); const nonce = crypto.randomUUID();
    return { device, timestamp, nonce, signature: await this.signPeerChallenge(deviceAssertionMessage(device.installationId, timestamp, nonce)) };
  };
  now = () => this.clockAnchor ? this.clockAnchor.server + performance.now() - this.clockAnchor.local : Date.now();
  notifyPeers = () => {
    if (typeof window === 'undefined') return;
    const message = { source: this.source, id: crypto.randomUUID() };
    this.broadcast?.postMessage(message);
    try { localStorage.setItem('f8-account-change-v2', JSON.stringify(message)); } catch { /* BroadcastChannel remains available when storage is restricted. */ }
  };
  setAccess = (access: AccessState, verifiedOffline = false) => {
    this.clockAnchor = { server: verifiedOffline ? Date.now() : access.serverNow, local: performance.now() };
    this.update({ access, config: access.config, loading: false, error: null, verifiedOffline });
    if (this.leaseRefreshTimer) clearTimeout(this.leaseRefreshTimer);
    // Refresh paid leases once near expiry, rather than polling throughout the day.
    if (typeof window !== 'undefined' && access.kind === 'paid' && access.expiresAt && access.paidUntil && access.paidUntil > access.expiresAt) {
      const delay = Math.max(1000, access.expiresAt - this.now() - 60_000);
      this.leaseRefreshTimer = setTimeout(() => { void this.refresh().catch(() => {}); }, delay);
    }
    try {
      if (access.kind === 'paid' && access.proof) localStorage.setItem(CACHE_KEY, JSON.stringify({ ...access, account: null, devices: [], orders: [] }));
      else localStorage.removeItem(CACHE_KEY);
    } catch { /* Online access does not depend on browser cache. */ }
  };
  initialize = (): Promise<void> => this.initializing ||= this.start();
  private async start() {
    if (typeof window === 'undefined') return;
    this.update({ loading: true });
    try {
      const device = await this.getIdentity(); this.update({ device });
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as AccessState | null;
        const restored = cached && await restorePaidLease(cached, device, await readTrustedConfig());
        if (restored) this.setAccess(restored, true);
      } catch { /* Treat an absent or invalid offline lease as no cached access. */ }
      try {
        const config = await this.request<MarketConfig>('/config'); await rememberNetworkConfig(config);
        if (this.snapshot.verifiedOffline && this.snapshot.access) {
          const refreshed = await restorePaidLease(this.snapshot.access, device, config);
          if (refreshed) this.setAccess(refreshed, true);
          else { this.update({ access: null, verifiedOffline: false }); try { localStorage.removeItem(CACHE_KEY); } catch { /* A revoked key cannot restore the cached lease. */ } }
        }
        this.update({ config });
      } catch { /* An offline paid lease can still be used. */ }
      await this.refresh();
    } catch (error) { this.update({ loading: false, error: error instanceof Error ? error.message : 'Could not check access.' }); }
    window.addEventListener('online', () => { void this.refresh().catch(() => {}); });
    this.source = crypto.randomUUID();
    const receive = (message: unknown) => {
      const value = message as {source?: string; id?: string};
      if (!value?.id || value.source === this.source || this.seenMessages.has(value.id)) return;
      this.seenMessages.add(value.id); if (this.seenMessages.size > 100) this.seenMessages.delete(this.seenMessages.values().next().value!);
      if (this.peerRefreshTimer) clearTimeout(this.peerRefreshTimer);
      this.peerRefreshTimer = setTimeout(() => { void this.refresh().catch(() => {}); }, 150);
    };
    if ('BroadcastChannel' in window) { this.broadcast = new BroadcastChannel('f8-account-v2'); this.broadcast.onmessage = event => receive(event.data); }
    window.addEventListener('storage', event => { if (event.key === 'f8-account-change-v2' && event.newValue) { try { receive(JSON.parse(event.newValue)); } catch { /* Ignore unrelated/malformed browser messages. */ } } });
    const visible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - this.lastVisibilityRefresh < 10_000) return;
      this.lastVisibilityRefresh = Date.now(); void this.refresh().catch(() => {});
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
  }
  refresh = (): Promise<AccessState> => this.refreshing ||= this.loadAccess().finally(() => { this.refreshing = null; });
  private async loadAccess(): Promise<AccessState> {
    this.update({ loading: true, error: null });
    try {
      const access = await this.request<AccessState>('/access', { assertion: await this.assertion() });
      await rememberNetworkConfig(access.config);
      this.setAccess(access); return access;
    } catch (error) {
      this.update({ loading: false, error: error instanceof Error ? error.message : 'Could not check access.' });
      throw error;
    }
  }
  request = async <T>(path: string, body?: unknown, options?: {timeoutMs?: number}): Promise<T> => {
    const controller = options?.timeoutMs ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), options!.timeoutMs) : null;
    let response: Response; let result: { error?: string; code?: string } & Record<string, unknown>;
    try {
      response = await fetch(`/api/market${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller?.signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      result = await response.json() as typeof result;
    }
    finally { if (timeout) clearTimeout(timeout); }
    if (!response.ok) throw Object.assign(new Error(result.error || 'This request could not be completed. Please try again.'), { code: result.code, status: response.status });
    if (body !== undefined && /^(?:\/auth\/|\/devices\/|\/account\/delete|\/orders(?:\/|$)|\/ads\/complete)/.test(path)) this.notifyPeers();
    return result as T;
  };
}
export const accessStore = new AccessStore();
export const accessRuntime = {
  getAccess: () => accessStore.getSnapshot().access,
  getIdentity: accessStore.getIdentity,
  signChallenge: accessStore.signPeerChallenge,
  subscribe: accessStore.subscribe,
  now: accessStore.now,
};
