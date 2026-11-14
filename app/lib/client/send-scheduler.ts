import {FREE_SPEED_RATIO} from '../market/plans';
import {MAX_CHUNK} from './framing';

export interface SpeedPolicy {
  calibration: 'waiting' | 'measuring' | 'complete';
  referenceBytesPerSecond: number;
  freeLimitBytesPerSecond: number;
  userLimitBytesPerSecond: number;
  freeRatio: number;
}
type Waiter = {bytes: number; free: () => boolean; current: () => boolean; resolve: (allowed: boolean) => void};
class Bucket {
  private tokens = MAX_CHUNK; private at = 0;
  reset(at: number) {this.tokens = MAX_CHUNK; this.at = at;}
  available(bytes: number, rate: number, at: number): boolean {
    this.tokens = Math.min(MAX_CHUNK, this.tokens + Math.max(0, at - this.at) * rate / 1000); this.at = at;
    return this.tokens >= bytes;
  }
  spend(bytes: number) {this.tokens -= bytes;}
}
/** One scheduler belongs to the sender, including every connection in a group. */
export class SenderScheduler {
  private freeBucket = new Bucket(); private totalBucket = new Bucket();
  private waiters: Waiter[] = []; private timer: ReturnType<typeof setTimeout> | null = null;
  private manualLimit = 0; private baseline = 0; private scheduled = 0; private acknowledged = 0; private reserved = 0;
  private activeMs = 0; private last = 0; private started = false; private measuring = true;
  private streams = new Set<string>(); private confirmed = new Map<string, number>();
  private routes = new Map<string, string>();
  constructor(private clock: () => number = () => performance.now()) {this.last = this.clock(); this.freeBucket.reset(this.last); this.totalBucket.reset(this.last);}
  getSnapshot(): SpeedPolicy {
    this.advance();
    return {calibration: this.baseline ? 'complete' : this.started ? 'measuring' : 'waiting', referenceBytesPerSecond: this.baseline, freeLimitBytesPerSecond: this.baseline * FREE_SPEED_RATIO, userLimitBytesPerSecond: this.manualLimit, freeRatio: FREE_SPEED_RATIO};
  }
  setUserLimit(mbps: number) {this.manualLimit = Number.isFinite(mbps) ? Math.max(0, mbps) * 125000 : 0; this.drain();}
  setActive(stream: string, active: boolean) {this.advance(); if (active) this.streams.add(stream); else this.streams.delete(stream);}
  route(stream: string, identity: string) {
    const previous = this.routes.get(stream); this.routes.set(stream, identity);
    if (previous !== undefined && previous !== identity) this.retest();
  }
  retest() {
    this.activeMs = 0; this.scheduled = 0; this.acknowledged = 0; this.reserved = 0; this.baseline = 0;
    this.started = false; this.measuring = true; this.last = this.clock();
    this.freeBucket.reset(this.last); this.drain();
  }
  sent(bytes: number) {
    this.advance(); this.reserved = Math.max(0, this.reserved - bytes); if (!this.measuring) return;
    this.started = true; this.scheduled += bytes;
    // A byte-limited calibration waits for these payloads to be acknowledged.
    this.maybeFinish();
  }
  cancelReservation(bytes: number) {this.reserved = Math.max(0, this.reserved - bytes);}
  ack(stream: string, cumulativeBytes: number) {
    const previous = this.confirmed.get(stream) || 0; this.confirmed.set(stream, cumulativeBytes);
    if (this.measuring) this.acknowledged += Math.max(0, cumulativeBytes - previous);
    this.advance();
  }
  private advance() {
    const at = this.clock();
    if (this.measuring && this.started && this.streams.size) this.activeMs += Math.max(0, at - this.last);
    this.last = at; this.maybeFinish();
  }
  private maybeFinish() {
    if (!this.measuring || !this.started || !this.acknowledged || this.activeMs <= 0) return;
    if (this.activeMs < 3000 && !(this.scheduled >= 32 * 1024 * 1024 && this.acknowledged >= this.scheduled)) return;
    this.baseline = this.acknowledged / (this.activeMs / 1000); this.measuring = false;
    this.freeBucket.reset(this.clock());
  }
  acquire(bytes: number, free: () => boolean, current: () => boolean): Promise<boolean> {
    if (bytes > MAX_CHUNK || bytes <= 0) return Promise.resolve(false);
    return new Promise(resolve => {this.waiters.push({bytes, free, current, resolve}); this.drain();});
  }
  private drain() {
    if (this.timer) {clearTimeout(this.timer); this.timer = null;}
    this.advance(); const at = this.clock(); const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (!waiter.current()) {waiter.resolve(false); continue;}
      // Stop the warm-up at the payload budget (within one frame), then wait
      // for receiver acknowledgements instead of silently measuring extra data.
      if (this.measuring && this.scheduled + this.reserved >= 32 * 1024 * 1024) {remaining.push(waiter); continue;}
      const freeRate = waiter.free() ? this.baseline * FREE_SPEED_RATIO : 0;
      const totalReady = !this.manualLimit || this.totalBucket.available(waiter.bytes, this.manualLimit, at);
      const freeReady = !freeRate || this.freeBucket.available(waiter.bytes, freeRate, at);
      if (!totalReady || !freeReady) {remaining.push(waiter); continue;}
      if (this.manualLimit) this.totalBucket.spend(waiter.bytes);
      if (freeRate) this.freeBucket.spend(waiter.bytes);
      if (this.measuring) this.reserved += waiter.bytes;
      waiter.resolve(true);
    }
    this.waiters = remaining;
    if (remaining.length) this.timer = setTimeout(() => this.drain(), 10);
  }
  remove(stream: string) {this.setActive(stream, false); this.confirmed.delete(stream);}
  destroy() {if (this.timer) clearTimeout(this.timer); this.timer = null; for (const waiter of this.waiters) waiter.resolve(false); this.waiters = []; this.streams.clear();}
}
