import { sha256 } from '@noble/hashes/sha2.js';
const hashes = new Map<string, ReturnType<typeof sha256.create>>();
self.onmessage = (event: MessageEvent<{type: string; id: string; data?: ArrayBuffer; request?: string}>) => {
  const {type, id, data, request} = event.data;
  try {
    if (type === 'start') hashes.set(id, sha256.create());
    if (type === 'update') { const hash = hashes.get(id); if (!hash || !data) throw new Error('Missing hash state.'); hash.update(new Uint8Array(data)); }
    if (type === 'finish') { const hash = hashes.get(id); if (!hash) throw new Error('Missing hash state.'); const digest = [...hash.digest()].map(byte => byte.toString(16).padStart(2, '0')).join(''); hashes.delete(id); self.postMessage({id, digest}); }
    if (type === 'flush') self.postMessage({id: request, digest: ''});
    if (type === 'cancel') hashes.delete(id);
  } catch (error) { self.postMessage({id, error: error instanceof Error ? error.message : 'Hash failed.'}); }
};
