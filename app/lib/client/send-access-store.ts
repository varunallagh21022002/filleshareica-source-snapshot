import { accessStore } from './access-store';
import { offlineEventText, type OfflineSendEvent, type PreparedSend, type SendAccessSummary, type SendCredit, type SendIntent, type SendMilestone, type SendPermit, type SendRuntime } from '../market/send-types';
import type { AccessState } from '../market/types';

export const EMPTY_SEND_SUMMARY: SendAccessSummary = { policyVersion: 2, creditAvailable: false, credit: null, pendingOfflineAds: 0, strictCatchUp: false };
export interface JournalOperation { intent: SendIntent; permit: SendPermit; source: 'online' | 'offline'; status: 'prepared' | 'verified' | 'released'; credit: SendCredit | null; ownerId?: string; premiumCovered?: boolean; adsTotal?: number; adsCompleted?: number; event?: OfflineSendEvent; acknowledged?: boolean; }
export interface SendJournalState { installationId: string; summary: SendAccessSummary; operations: Record<string, JournalOperation>; }
export interface JournalAdapter { transact<T>(update: (state: SendJournalState) => T, namespace?: string): Promise<T>; }
const emptyJournal = (installationId = 'unbound-test'): SendJournalState => ({ installationId, summary: { ...EMPTY_SEND_SUMMARY }, operations: {} });

export class MemoryJournalAdapter implements JournalAdapter {
  private states = new Map<string, SendJournalState>(); private tail = Promise.resolve();
  transact<T>(update: (state: SendJournalState) => T, namespace = 'unbound-test'): Promise<T> {
    const result = this.tail.then(() => { const state = this.states.get(namespace) || emptyJournal(namespace); this.states.set(namespace, state); return update(state); }); this.tail = result.then(() => {}, () => {}); return result;
  }
}
class BrowserJournalAdapter implements JournalAdapter {
  private fallback = new MemoryJournalAdapter(); private unavailable = false;
  async transact<T>(update: (state: SendJournalState) => T, namespace = 'unbound-test'): Promise<T> {
    if (this.unavailable || typeof indexedDB === 'undefined') return this.fallback.transact(update, namespace);
    let database: IDBDatabase;
    try { database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('f8-send-accounting-v2', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('journal');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } catch { this.unavailable = true; return this.fallback.transact(update, namespace); }
    try { return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('journal', 'readwrite'); const store = transaction.objectStore('journal'); const request = store.get(namespace); let result: T;
      request.onsuccess = () => { try { const state: SendJournalState = request.result || emptyJournal(namespace); result = update(state); store.put(state, namespace); } catch (error) { transaction.abort(); reject(error); } };
      transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('Local send accounting could not be saved.'));
    }); } finally { database.close(); }
  }
}
/** Atomic reservations and idempotent milestones are shared by all tabs through one IndexedDB record. */
export class SendJournal {
  constructor(private adapter: JournalAdapter = new BrowserJournalAdapter()) {}
  private installationId = 'unbound-test';
  bindInstallation(id: string) { this.installationId = id; return this.read(); }
  private transact<T>(update: (state: SendJournalState) => T) { return this.adapter.transact(update, this.installationId); }
  read() { return this.transact(state => structuredClone(state)); }
  merge(summary: SendAccessSummary, acknowledged: string[] = [], premium = false) {
    return this.transact(state => {
      for (const id of acknowledged) if (state.operations[id]) { state.operations[id].acknowledged = true; delete state.operations[id].event; }
      if (premium) for (const operation of Object.values(state.operations)) {
        if (operation.status !== 'verified') continue;
        operation.premiumCovered = true; operation.acknowledged = true; delete operation.event;
      }
      state.summary = structuredClone(summary);
      const credit = state.summary.credit;
      if (credit && Object.values(state.operations).some(operation => operation.credit?.id === credit.id && operation.status !== 'released' && !operation.acknowledged)) { state.summary.credit = null; state.summary.creditAvailable = false; }
      return structuredClone(state);
    });
  }
  record(intent: SendIntent, permit: SendPermit, source: 'online' | 'offline', cachedCredit: SendCredit | null = null, premiumCovered = false, ownerId?: string) {
    return this.transact(state => {
      const previous = state.operations[intent.operationId];
      if (previous && previous.intent.manifestDigest !== intent.manifestDigest) throw new Error('This send reference belongs to another selection. Select the files again.');
      if (previous) {
        previous.permit = permit; previous.source = source; previous.premiumCovered = premiumCovered; previous.ownerId = ownerId;
        if (cachedCredit) previous.credit = cachedCredit;
        if (previous.status === 'released') {
          previous.status = 'prepared'; previous.acknowledged = false;
          if (state.summary.credit?.id === previous.credit?.id) { state.summary.credit = null; state.summary.creditAvailable = false; }
        }
        return structuredClone(previous);
      }
      let credit = cachedCredit;
      if (source === 'offline' && !premiumCovered && permit.decision !== 'premium' && state.summary.creditAvailable && state.summary.credit) {
        credit = state.summary.credit; state.summary.credit = null; state.summary.creditAvailable = false;
      }
      const operation: JournalOperation = { intent: structuredClone(intent), permit: structuredClone(permit), source, status: 'prepared', credit: credit ? structuredClone(credit) : null, premiumCovered, ownerId };
      state.operations[intent.operationId] = operation; return structuredClone(operation);
    });
  }
  recoverInterrupted(ownerId: string) {
    return this.transact(state => {
      for (const operation of Object.values(state.operations)) {
        if (operation.ownerId !== ownerId || operation.status !== 'prepared') continue;
        operation.status = 'released'; operation.acknowledged = false;
        if (operation.credit && !state.summary.creditAvailable) { state.summary.credit = operation.credit; state.summary.creditAvailable = true; }
      }
      return structuredClone(state);
    });
  }
  milestone(id: string, status: 'verified' | 'released', event?: OfflineSendEvent) {
    return this.transact(state => {
      const operation = state.operations[id]; if (!operation || operation.status === 'verified') return structuredClone(state);
      operation.status = status;
      if (status === 'verified' && event) { operation.event = event; operation.acknowledged = false; }
      if (status === 'released' && operation.credit && !state.summary.creditAvailable) { state.summary.credit = operation.credit; state.summary.creditAvailable = true; }
      return structuredClone(state);
    });
  }
  progress(id: string, required: number) {
    return this.transact(state => {
      const operation = state.operations[id];
      if (!operation) return { total: required, completed: 0 };
      const previousCompleted = operation.adsCompleted || 0;
      operation.adsTotal = Math.max(operation.adsTotal || 0, required + previousCompleted);
      operation.adsCompleted = Math.max(previousCompleted, operation.adsTotal - required);
      return { total: operation.adsTotal, completed: operation.adsCompleted };
    });
  }
  unreserveCredit(id: string) { return this.transact(state => { if (state.operations[id]) state.operations[id].credit = null; }); }
}
export interface SendDialogState { mode: 'send' | 'credit'; intent: SendIntent | null; stage: 'preparing' | 'offer' | 'watching' | 'error'; prepared: PreparedSend | null; attempt: { attemptId: string; readyAt: number } | null; error: string | null; totalAds?: number; }
export interface SendAccessSnapshot { initialized: boolean; summary: SendAccessSummary; unsynced: number; syncing: boolean; error: string | null; message: string | null; dialog: SendDialogState | null; }
export function summarizeJournal(state: SendJournalState): { summary: SendAccessSummary; unsynced: number } {
  const unsynced = Object.values(state.operations).filter(operation => operation.event && !operation.acknowledged);
  const known = new Set(state.summary.pendingOperationIds || []);
  const pending = state.summary.pendingOfflineAds + (state.summary.pendingOperationIdsComplete === false ? 0 : unsynced.filter(operation => !operation.credit && operation.permit.decision === 'offline' && !known.has(operation.intent.operationId)).length);
  return { summary: { ...state.summary, pendingOfflineAds: pending }, unsynced: unsynced.length };
}
const INITIAL: SendAccessSnapshot = { initialized: false, summary: EMPTY_SEND_SUMMARY, unsynced: 0, syncing: false, error: null, message: null, dialog: null };
type Gate = { intent: SendIntent; promise: Promise<SendPermit | null>; resolve: (permit: SendPermit | null) => void };
function networkUnavailable(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException && error.name === 'AbortError' || (typeof error === 'object' && error !== null && 'status' in error && Number(error.status) >= 500);
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'This send could not be prepared. Try again or cancel.'; }
function accessSummary(access: AccessState | null): SendAccessSummary | null { return (access as (AccessState & {sendAccess?: SendAccessSummary}) | null)?.sendAccess || null; }

class SendAccessStore implements SendRuntime {
  private snapshot: SendAccessSnapshot = INITIAL; private listeners = new Set<() => void>();
  private journal = new SendJournal(); private initializing: Promise<void> | null = null; private syncing: Promise<void> | null = null;
  private gate: Gate | null = null; private channel: BroadcastChannel | null = null; private source = ''; private lastAccess: AccessState | null = null;
  private dialogVersion = 0; private lastSyncError: unknown = null; private ownerId = '';
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(next: Partial<SendAccessSnapshot>) { this.snapshot = { ...this.snapshot, ...next }; for (const listener of this.listeners) listener(); }
  private publish(state: SendJournalState, broadcast = true) {
    this.update({ initialized: true, ...summarizeJournal(state) });
    if (broadcast) this.channel?.postMessage({ source: this.source });
  }
  private async merge(summary: SendAccessSummary, acknowledged: string[] = []) { this.publish(await this.journal.merge(summary, acknowledged, this.isPremium())); }
  initialize = (): Promise<void> => this.initializing ||= this.start();
  private async start() {
    if (typeof window === 'undefined') return;
    this.source = crypto.randomUUID();
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    this.ownerId = navigation?.type !== 'navigate' && sessionStorage.getItem('f8-send-owner-v2') || crypto.randomUUID();
    sessionStorage.setItem('f8-send-owner-v2', this.ownerId);
    if ('BroadcastChannel' in window) { this.channel = new BroadcastChannel('f8-send-accounting-v2'); this.channel.onmessage = event => { if (event.data?.source !== this.source) void this.journal.read().then(state => this.publish(state, false)); }; }
    await this.journal.bindInstallation((await accessStore.getIdentity()).installationId);
    this.publish(await this.journal.recoverInterrupted(this.ownerId), false);
    const updateAccess = () => {
      const access = accessStore.getSnapshot().access;
      if (access === this.lastAccess) return; this.lastAccess = access;
      const summary = accessSummary(access); if (summary) void this.merge(summary);
    };
    accessStore.subscribe(updateAccess); updateAccess();
    window.addEventListener('online', () => { void this.sync(); });
    void accessStore.initialize().then(() => this.sync());
  }
  isPremium = () => {
    const access = accessStore.getSnapshot().access;
    return access?.kind === 'paid' && access.allowed && !!access.expiresAt && access.expiresAt > accessStore.now();
  };
  private async api<T>(path: string, body: Record<string, unknown>, timeoutMs = 8000): Promise<T> { return accessStore.request<T>(path, { ...body, assertion: await accessStore.assertion() }, { timeoutMs }); }
  private async savePrepared(intent: SendIntent, prepared: PreparedSend) {
    const local = await this.journal.read();
    // A retry reuses its original authorization; it must never take another ready credit.
    const prior = local.operations[intent.operationId] ? null : local.summary.credit;
    if (prepared.decision === 'no_fill') await this.journal.unreserveCredit(intent.operationId);
    await this.merge(prepared.sendAccess);
    const permit = prepared.permit || { policyVersion: 2 as const, operationId: intent.operationId, sessionId: intent.sessionId, manifestDigest: intent.manifestDigest, recipientIds: intent.recipientIds, senderInstallationId: (await accessStore.getIdentity()).installationId, decision: prepared.currentAds === 0 ? 'credit' as const : 'offline' as const, issuedAt: Math.floor(accessStore.now()), expiresAt: Math.floor(accessStore.now()) + 10 * 60_000, proof: null };
    await this.journal.record(intent, permit, 'online', prepared.reservedCredit || (permit.decision === 'credit' ? prior : null), false, this.ownerId); this.publish(await this.journal.read());
  }
  private finish(permit: SendPermit | null) { const gate = this.gate; this.gate = null; this.dialogVersion++; this.update({ dialog: null }); gate?.resolve(permit); }
  authorize = async (intent: SendIntent): Promise<SendPermit | null> => {
    await this.initialize();
    if (this.gate) return this.gate.intent.operationId === intent.operationId ? this.gate.promise : null;
    let resolve!: Gate['resolve']; const promise = new Promise<SendPermit | null>(done => { resolve = done; });
    this.gate = { intent, promise, resolve }; this.dialogVersion++;
    if (!this.isPremium()) this.update({ dialog: { mode: 'send', intent, stage: 'preparing', prepared: null, attempt: null, error: null }, error: null, message: null });
    void this.prepare(intent); return promise;
  };
  private async prepare(intent: SendIntent) {
    const gate = this.gate;
    try {
      const local = await this.journal.read();
      if (Object.values(local.operations).some(operation => operation.event && !operation.acknowledged)) { await this.sync(); if (this.lastSyncError) throw this.lastSyncError; }
      if (this.gate !== gate) return;
      const deadline = performance.now() + 8000;
      const prepared = await this.api<PreparedSend>('/sends/prepare', { intent }, Math.max(1, deadline - performance.now())); await this.savePrepared(intent, prepared);
      if (this.gate !== gate) { if (prepared.permit) void this.milestone({ intent, status: 'released' }); return; }
      if (prepared.permit) { this.finish(prepared.permit); return; }
      const progress = await this.journal.progress(intent.operationId, prepared.adsRequired);
      this.update({ dialog: { mode: 'send', intent, stage: 'offer', prepared, attempt: null, error: null, totalAds: progress.total } });
      const config = accessStore.getSnapshot().config;
      if (config?.adsMode !== 'demo' || !config.development) await this.noFill('provider_unavailable', Math.max(1, deadline - performance.now()));
    } catch (error) {
      if (this.gate !== gate) return;
      if (networkUnavailable(error) || typeof navigator !== 'undefined' && !navigator.onLine) await this.offline(intent);
      else this.update({ dialog: { mode: 'send', intent, stage: 'error', prepared: null, attempt: null, error: errorText(error) } });
    }
  }
  private async offline(intent: SendIntent) {
    const gate = this.gate;
    if (!gate || gate.intent.operationId !== intent.operationId) return;
    try {
      const identity = await accessStore.getIdentity(); const premium = this.isPremium();
      const permit: SendPermit = { policyVersion: 2, operationId: intent.operationId, sessionId: intent.sessionId, manifestDigest: intent.manifestDigest, recipientIds: intent.recipientIds, senderInstallationId: identity.installationId, decision: 'offline', issuedAt: Math.floor(accessStore.now()), expiresAt: Math.floor(accessStore.now()) + 10 * 60_000, proof: null };
      await this.journal.record(intent, permit, 'offline', null, premium, this.ownerId); this.publish(await this.journal.read());
      if (this.gate !== gate) { void this.milestone({ intent, status: 'released' }); return; }
      this.update({ message: premium ? 'Premium access verified from this installation’s offline lease.' : 'Offline send allowed. Completed sends will be reconciled when this device is online.' }); this.finish(permit);
    } catch (error) { this.update({ dialog: { mode: 'send', intent, stage: 'error', prepared: null, attempt: null, error: `Local send accounting is unavailable. ${errorText(error)}` } }); }
  }
  cancel = () => {
    const intent = this.gate?.intent; this.finish(null);
    if (intent) void this.milestone({ intent, status: 'released' });
  };
  retry = () => { const intent = this.gate?.intent; if (intent) { this.update({ dialog: { mode: 'send', intent, stage: 'preparing', prepared: null, attempt: null, error: null } }); void this.prepare(intent); } };
  prepareCredit = async () => {
    await this.initialize(); if (this.gate || this.snapshot.dialog) return;
    this.dialogVersion++;
    this.update({ dialog: { mode: 'credit', intent: null, stage: 'offer', prepared: null, attempt: null, error: null }, error: null });
  };
  startAd = async () => {
    const dialog = this.snapshot.dialog; if (!dialog) return; const version = this.dialogVersion;
    this.update({ dialog: { ...dialog, stage: 'preparing', error: null } });
    const purpose = dialog.mode === 'credit' ? 'credit' : dialog.prepared?.sendAccess.strictCatchUp && dialog.prepared.pendingAds > 0 ? 'catchup' : 'send';
    try {
      const config = accessStore.getSnapshot().config;
      if (config?.adsMode !== 'demo' || !config.development) { if (dialog.mode === 'send') await this.noFill('provider_unavailable'); else this.update({ dialog: { ...dialog, stage: 'error', error: 'Preparing a credit needs an available approved ad. No live provider is enabled yet. You can still press Send; an unavailable ad will not block that send.' } }); return; }
      const attempt = await this.api<{ attemptId: string; readyAt: number }>('/ads/start', { purpose, operationId: dialog.intent?.operationId });
      if (version !== this.dialogVersion || !this.snapshot.dialog) return;
      this.update({ dialog: { ...dialog, stage: 'watching', attempt, error: null } });
    } catch (error) {
      if (version !== this.dialogVersion || !this.snapshot.dialog) return;
      const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
      if (dialog.mode === 'send' && status === 409 && dialog.intent) await this.prepare(dialog.intent);
      else if (dialog.mode === 'send' && status !== 401 && status !== 403) await this.noFill(error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'provider_error');
      else this.update({ dialog: { ...dialog, stage: 'error', error: errorText(error) } });
    }
  };
  completeAd = async () => {
    const dialog = this.snapshot.dialog; if (!dialog?.attempt) return; const version = this.dialogVersion;
    this.update({ dialog: { ...dialog, stage: 'preparing', error: null } });
    try {
      const access = await this.api<AccessState>('/ads/complete', { attemptId: dialog.attempt.attemptId }); accessStore.setAccess(access);
      const summary = accessSummary(access); if (summary) await this.merge(summary);
      if (version !== this.dialogVersion || !this.snapshot.dialog) return;
      if (dialog.mode === 'credit') { this.dialogVersion++; this.update({ dialog: null, message: 'One send is prepared on this installation.' }); return; }
      if (dialog.intent) await this.prepare(dialog.intent);
    } catch (error) { if (version === this.dialogVersion && this.snapshot.dialog) this.update({ dialog: { ...dialog, stage: 'error', error: errorText(error) } }); }
  };
  noFill = async (reason: 'no_fill' | 'timeout' | 'provider_error' | 'provider_unavailable' = 'no_fill', timeoutMs = 4000) => {
    const gate = this.gate; const intent = gate?.intent; if (!intent) return;
    try {
      const prepared = await this.api<PreparedSend>('/sends/no-fill', { operationId: intent.operationId, reason }, timeoutMs); await this.savePrepared(intent, prepared);
      if (this.gate !== gate) { void this.milestone({ intent, status: 'released' }); return; }
      if (prepared.permit) { this.update({ message: 'No ad was available. This send can continue; previous offline sends remain recorded.' }); this.finish(prepared.permit); }
      else this.update({ dialog: { mode: 'send', intent, stage: 'error', prepared, attempt: null, error: 'The server could not prepare this send. Retry or cancel.' } });
    } catch (error) { if (this.gate !== gate) return; if (networkUnavailable(error)) await this.offline(intent); else this.update({ dialog: { mode: 'send', intent, stage: 'error', prepared: null, attempt: null, error: errorText(error) } }); }
  };
  milestone = async ({ intent, status }: SendMilestone): Promise<void> => {
    await this.initialize(); const state = await this.journal.read(); const operation = state.operations[intent.operationId]; if (!operation || operation.status === 'verified') return;
    let event: OfflineSendEvent | undefined;
    if (status === 'verified' && operation.permit.decision !== 'premium' && !operation.premiumCovered && !this.isPremium()) {
      const value = { operationId: intent.operationId, sessionId: intent.sessionId, manifestDigest: intent.manifestDigest, installationId: (await accessStore.getIdentity()).installationId, verifiedAt: Math.floor(accessStore.now()), ...(operation.credit ? { creditId: operation.credit.id } : {}) };
      event = { ...value, signature: await accessStore.signPeerChallenge(offlineEventText(value)) };
    }
    this.publish(await this.journal.milestone(intent.operationId, status, event));
    if (operation.source === 'online') {
      try { const result = await this.api<{sendAccess: SendAccessSummary}>('/sends/commit', { operationId: intent.operationId, status }); await this.merge(result.sendAccess, [intent.operationId]); }
      catch (error) { this.update({ error: `Send progress is saved locally. ${errorText(error)}` }); }
    } else if (event && typeof navigator !== 'undefined' && navigator.onLine) await this.sync();
  };
  sync = (): Promise<void> => this.syncing ||= this.synchronize().finally(() => { this.syncing = null; });
  private async synchronize() {
    await this.initialize(); if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    this.lastSyncError = null; this.update({ syncing: true });
    try {
      let state = await this.journal.read();
      for (const operation of Object.values(state.operations).filter(value => value.source === 'online' && value.status === 'released' && !value.acknowledged)) {
        const result = await this.api<{sendAccess: SendAccessSummary}>('/sends/commit', { operationId: operation.intent.operationId, status: 'released' }); await this.merge(result.sendAccess, [operation.intent.operationId]);
      }
      for (;;) {
        state = await this.journal.read(); const events = Object.values(state.operations).filter(operation => operation.event && !operation.acknowledged).map(operation => operation.event!);
        if (!events.length) break;
        const batch = events.slice(0, 100);
        const result = await this.api<{sendAccess: SendAccessSummary; acknowledgedOperationIds: string[]}>('/usage/sync', { events: batch }, 4000);
        if (!result.acknowledgedOperationIds.some(id => batch.some(event => event.operationId === id))) throw new Error('Offline receipt reconciliation made no progress. Retry when the service is available.');
        await this.merge(result.sendAccess, result.acknowledgedOperationIds);
      }
      this.update({ syncing: false, error: null });
    } catch (error) { this.lastSyncError = error; this.update({ syncing: false, error: `Offline history will sync when available. ${errorText(error)}` }); }
  }
}
export const sendAccessStore = new SendAccessStore();
