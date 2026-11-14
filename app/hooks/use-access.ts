'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { accessStore } from '@/lib/client/access-store';

export function useAccess() {
  const snapshot = useSyncExternalStore(accessStore.subscribe, accessStore.getSnapshot, accessStore.getSnapshot);
  useEffect(() => { void accessStore.initialize(); }, []);
  return snapshot;
}
