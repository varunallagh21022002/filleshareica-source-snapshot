'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { sendAccessStore } from '@/lib/client/send-access-store';
export function useSendAccess() {
  const snapshot = useSyncExternalStore(sendAccessStore.subscribe, sendAccessStore.getSnapshot, sendAccessStore.getSnapshot);
  useEffect(() => { void sendAccessStore.initialize(); }, []);
  return snapshot;
}
