'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { GroupShareClient } from '@/lib/client/group-controller';
import type { ShareController } from '@/lib/share-types';
import { accessStore } from '@/lib/client/access-store';
import { sendAccessStore } from '@/lib/client/send-access-store';

export function useShare(): ShareController {
  const [client] = useState(() => new GroupShareClient({sendRuntime: sendAccessStore, accessRuntime: {
    getAccess: () => accessStore.getSnapshot().access,
    getIdentity: () => accessStore.getIdentity(),
    signChallenge: value => accessStore.signPeerChallenge(value),
    subscribe: listener => accessStore.subscribe(listener),
    now: () => accessStore.now(),
  }}));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { void accessStore.initialize(); void sendAccessStore.initialize(); client.initialize(); return () => client.destroy(); }, [client]);
  return {...state,
    createSession: client.createSession, joinSession: client.joinSession, approvePeer: client.approvePeer, disconnect: client.disconnect, endSession: client.endSession,
    setRecipient: client.setRecipient, sendChat: client.sendChat, approveMember: client.approveMember,
    addFiles: client.addFiles, removeFile: client.removeFile, clearFiles: client.clearFiles, sendSelected: client.sendSelected,
    acceptBatch: client.acceptBatch, declineBatch: client.declineBatch, pauseTransfer: client.pauseTransfer, resumeTransfer: client.resumeTransfer,
    cancelTransfer: client.cancelTransfer, retryTransfer: client.retryTransfer, downloadFile: client.downloadFile, saveFile: client.saveFile,
    chooseFolder: client.chooseFolder, clearFolder: client.clearFolder, dismissError: client.dismissError,
    updateSettings: client.updateSettings, testSpeed: client.testSpeed,
  };
}
