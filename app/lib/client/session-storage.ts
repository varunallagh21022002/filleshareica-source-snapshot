/** Credentials stay in this tab; never persist files or invite secrets in localStorage. */
export const SESSION_STORAGE_KEY = 'f8-active-session-v1';
export interface SavedShareSession {
  version: 1;
  sessionId: string;
  token: string;
  secret: string;
  role: 'host' | 'guest';
  slug: string;
  sessionName: string;
  expiresAt: number;
  connectionRevision: number;
  hadConnected: boolean;
  pendingTransfers: boolean;
}
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function readSavedSession(storage: SessionStorage): SavedShareSession | null {
  try {
    const item = JSON.parse(storage.getItem(SESSION_STORAGE_KEY) || 'null') as SavedShareSession | null;
    if (!item || item.version !== 1 || !/^[a-f0-9-]{36}$/i.test(item.sessionId) || !/^[a-f0-9]{64}$/.test(item.token) || !/^[A-Za-z0-9_-]{43}$/.test(item.secret) || !['host', 'guest'].includes(item.role) || typeof item.slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(item.slug) || typeof item.sessionName !== 'string' || item.sessionName.length > 80 || !Number.isFinite(item.expiresAt) || !Number.isSafeInteger(item.connectionRevision) || item.connectionRevision < 0 || typeof item.hadConnected !== 'boolean' || typeof item.pendingTransfers !== 'boolean') return null;
    return item;
  } catch { return null; }
}
export function saveSession(storage: SessionStorage, session: SavedShareSession): void {
  try { storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session)); } catch { /* Transfers still work when tab storage is unavailable. */ }
}
export function clearSavedSession(storage: SessionStorage): void {
  try { storage.removeItem(SESSION_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
}
