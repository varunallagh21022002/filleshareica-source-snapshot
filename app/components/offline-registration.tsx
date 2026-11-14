'use client';
import { useEffect } from 'react';
import {clearPreviewShell} from '@/lib/client/preview-cache';

/** Production app assets can be cached; credentials and API replies never are. */
export function OfflineRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') {
      void clearPreviewShell(window.location.origin, navigator.serviceWorker, window.caches).catch(() => {
        // Restricted browser storage must not prevent a local preview.
      });
      return;
    }
    void navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'}).catch(() => {
      // Sharing remains usable when installation or browser storage is blocked.
    });
  }, []);
  return null;
}
