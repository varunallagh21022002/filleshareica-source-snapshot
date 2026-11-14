export const DEFAULT_RECEIVE_BUDGET_BYTES = 32 * 1024 * 1024;
export const MAX_RECEIVE_WINDOW_BYTES = 4 * 1024 * 1024;
export const RECEIVE_QUEUE_SLACK_BYTES = 1024 * 1024;

const validBytes = (bytes: number): boolean => Number.isSafeInteger(bytes) && bytes >= 0;

/** Shared by all local peer connections. Credits stay reserved while disk/hash work runs. */
export class ReceiveFlowBudget {
  private reservations = new Map<object, number>();
  private listeners = new Set<() => void>();
  private reservedBytes = 0;
  private rawQueuedBytes = 0;
  private rawPeakBytes = 0;
  private notificationPending = false;
  private nextListener = 0;

  constructor(readonly limit = DEFAULT_RECEIVE_BUDGET_BYTES) {
    if (!validBytes(limit) || limit > Number.MAX_SAFE_INTEGER - RECEIVE_QUEUE_SLACK_BYTES) throw new RangeError('Use a safe, non-negative receive buffer limit.');
  }

  get used(): number { return this.reservedBytes; }
  get available(): number { return this.limit - this.reservedBytes; }
  get queuedBytes(): number { return this.rawQueuedBytes; }
  get peakQueuedBytes(): number { return this.rawPeakBytes; }

  acquire(owner: object, bytes: number): boolean {
    if (!owner || (typeof owner !== 'object' && typeof owner !== 'function') || !validBytes(bytes) || bytes > MAX_RECEIVE_WINDOW_BYTES) return false;
    if (this.reservations.has(owner)) return this.reservations.get(owner) === bytes;
    if (bytes > this.available) return false;
    this.reservations.set(owner, bytes);
    this.reservedBytes += bytes;
    return true;
  }

  release(owner: object): void {
    const bytes = this.reservations.get(owner);
    if (bytes === undefined) return;
    this.reservations.delete(owner);
    this.reservedBytes -= bytes;
    // A zero-size file did not occupy capacity; notifying here can create a wake-up loop.
    if (!bytes || this.notificationPending) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      const listeners = [...this.listeners];
      if (!listeners.length) return;
      const start = this.nextListener % listeners.length;
      this.nextListener = (start + 1) % listeners.length;
      // Rotate the first notified peer so repeated releases do not always favor one connection.
      for (let offset = 0; offset < listeners.length; offset++) {
        const listener = listeners[(start + offset) % listeners.length];
        if (this.listeners.has(listener)) listener();
      }
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Bound raw event queues independently of logical per-file receive credits. */
  enqueue(bytes: number): boolean {
    if (!validBytes(bytes) || bytes > this.limit + RECEIVE_QUEUE_SLACK_BYTES - this.rawQueuedBytes) return false;
    this.rawQueuedBytes += bytes;
    this.rawPeakBytes = Math.max(this.rawPeakBytes, this.rawQueuedBytes);
    return true;
  }

  dequeue(bytes: number): void {
    if (!validBytes(bytes) || bytes > this.rawQueuedBytes) throw new RangeError('Receive queue accounting underflow or invalid byte count.');
    this.rawQueuedBytes -= bytes;
  }
}
