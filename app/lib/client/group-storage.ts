/** Group credentials and invitation keys belong only to the current browser tab. */
export const GROUP_STORAGE_KEY = 'f8-active-group-v1';
export interface SavedGroup {
  version: 1; groupId: string; code: string; sessionName: string; memberId: string;
  token: string; role: 'host' | 'guest'; expiresAt: number; secret: string; pendingTransfers: boolean;
}
type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function readSavedGroup(storage: TabStorage): SavedGroup | null {
  try {
    const value = JSON.parse(storage.getItem(GROUP_STORAGE_KEY) || 'null') as SavedGroup | null;
    if (!value || value.version !== 1 || !/^[a-f0-9-]{36}$/i.test(value.groupId) || !/^[a-f0-9-]{36}$/i.test(value.memberId) || !/^[a-f0-9]{6}$/i.test(value.code) || !/^[a-f0-9]{64}$/i.test(value.token) || !/^[A-Za-z0-9_-]{43}$/.test(value.secret) || typeof value.sessionName !== 'string' || value.sessionName.length > 80 || !['host', 'guest'].includes(value.role) || !Number.isFinite(value.expiresAt) || typeof value.pendingTransfers !== 'boolean') return null;
    return value;
  } catch { return null; }
}
export function saveGroup(storage: TabStorage, group: SavedGroup): void { try { storage.setItem(GROUP_STORAGE_KEY, JSON.stringify(group)); } catch { /* Transfer remains available without reload recovery. */ } }
export function clearSavedGroup(storage: TabStorage): void { try { storage.removeItem(GROUP_STORAGE_KEY); } catch { /* Optional tab storage. */ } }
