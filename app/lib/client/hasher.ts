import { sha256 } from '@noble/hashes/sha2.js';
export class StreamingHasher {
  private worker: Worker | null = null;
  private counter = 0;
  private fault: Error | null = null;
  private local = new Map<string, ReturnType<typeof sha256.create>>();
  private pending = new Map<string, {resolve(value: string): void; reject(error: Error): void}>();
  constructor() {
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./hash.worker.ts', import.meta.url), {type: 'module'});
        this.worker.onmessage = ({data}: MessageEvent<{id: string; digest?: string; error?: string}>) => {
          const pending = this.pending.get(data.id);
          if (!pending) return;
          this.pending.delete(data.id);
          if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.digest!);
        };
        this.worker.onerror = () => { this.fault = new Error('File verification worker failed. Refresh the page before retrying.'); for (const pending of this.pending.values()) pending.reject(this.fault); this.pending.clear(); };
      } catch { this.worker = null; }
    }
  }
  start(id: string) { if (this.fault) throw this.fault; if (this.worker) this.worker.postMessage({type: 'start', id}); else this.local.set(id, sha256.create()); }
  update(id: string, bytes: ArrayBuffer) {
    if (this.fault) throw this.fault;
    if (this.worker) this.worker.postMessage({type: 'update', id, data: bytes}, [bytes]);
    else { const hash = this.local.get(id); if (!hash) throw new Error('Missing hash state.'); hash.update(new Uint8Array(bytes)); }
  }
  flush(id: string): Promise<void> {
    if (this.fault) return Promise.reject(this.fault);
    if (!this.worker) return Promise.resolve();
    const request = `${id}#${this.counter++}`;
    return new Promise((resolve, reject) => { this.pending.set(request, {resolve: () => resolve(), reject}); this.worker!.postMessage({type: 'flush', id, request}); });
  }
  finish(id: string): Promise<string> {
    if (this.fault) return Promise.reject(this.fault);
    if (this.worker) return new Promise((resolve, reject) => { this.pending.set(id, {resolve, reject}); this.worker!.postMessage({type: 'finish', id}); });
    const hash = this.local.get(id); if (!hash) return Promise.reject(new Error('Missing hash state.'));
    const digest = [...hash.digest()].map(byte => byte.toString(16).padStart(2, '0')).join(''); this.local.delete(id); return Promise.resolve(digest);
  }
  cancel(id: string) { this.worker?.postMessage({type: 'cancel', id}); this.local.delete(id); const pending = this.pending.get(id); pending?.reject(new Error('Transfer canceled.')); this.pending.delete(id); }
  destroy() { this.worker?.terminate(); this.worker = null; this.local.clear(); for (const pending of this.pending.values()) pending.reject(new Error('Session ended.')); this.pending.clear(); }
}
