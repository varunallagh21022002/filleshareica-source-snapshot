import type {SendIntent, SendPermit, SendRuntime} from '../market/send-types';

/** Shared across every recipient and retry of one immutable Send action. */
export class SendOperation {
  private attempts = new Map<string, 'pending' | 'verified' | 'released'>();
  private sealed = false; private verified = false; private released = false;
  private renewal: Promise<SendPermit | null> | null = null;
  constructor(readonly intent: SendIntent, public permit: SendPermit | null, private runtime?: SendRuntime, private report: (error: unknown) => void = () => {}) {}
  open() {this.sealed = false; this.released = false;}
  expect(key: string) {this.attempts.set(key, 'pending');}
  seal() {this.sealed = true; this.settle();}
  outcome(key: string, status: 'verified' | 'released') {if (this.attempts.has(key)) this.attempts.set(key, status); this.settle();}
  private settle() {
    if (!this.verified && [...this.attempts.values()].includes('verified')) {this.verified = true; void this.runtime?.milestone({intent: this.intent, status: 'verified'}).catch(this.report);}
    else if (this.sealed && !this.verified && !this.released && [...this.attempts.values()].every(status => status === 'released')) {this.released = true; void this.runtime?.milestone({intent: this.intent, status: 'released'}).catch(this.report);}
  }
  renew(): Promise<SendPermit | null> {
    if (!this.runtime) return Promise.resolve(this.permit);
    return this.renewal ||= this.runtime.authorize(this.intent).then(permit => {if (permit) this.permit = permit; return permit;}).finally(() => {this.renewal = null;});
  }
}
