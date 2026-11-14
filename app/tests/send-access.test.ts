import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryJournalAdapter, SendJournal, EMPTY_SEND_SUMMARY, summarizeJournal } from '../lib/client/send-access-store';
import type { OfflineSendEvent, SendCredit, SendIntent, SendPermit } from '../lib/market/send-types';

const credit: SendCredit = { id: 'credit-one', proof: 'signed-credit' };
const intent = (id: string): SendIntent => ({ operationId: id, sessionId: 'session-one', manifestDigest: 'a'.repeat(64), files: [{ id: 'opaque-file', size: 100 }], recipientIds: ['peer-one'] });
const permit = (id: string): SendPermit => ({ policyVersion: 2, operationId: id, sessionId: 'session-one', manifestDigest: 'a'.repeat(64), recipientIds: ['peer-one'], senderInstallationId: 'installation-one', decision: 'offline', issuedAt: 100, expiresAt: 1000, proof: null });
const event = (id: string, creditId?: string): OfflineSendEvent => ({ operationId: id, sessionId: 'session-one', manifestDigest: 'a'.repeat(64), installationId: 'installation-one', verifiedAt: 200, signature: 'signature', ...(creditId ? { creditId } : {}) });

test('two tabs atomically reserve only one unused prepared credit', async () => {
  const shared = new MemoryJournalAdapter(); const first = new SendJournal(shared); const second = new SendJournal(shared);
  await first.merge({ ...EMPTY_SEND_SUMMARY, creditAvailable: true, credit });
  const results = await Promise.all([first.record(intent('operation-one'), permit('operation-one'), 'offline'), second.record(intent('operation-two'), permit('operation-two'), 'offline')]);
  assert.equal(results.filter(value => value.credit?.id === credit.id).length, 1);
  assert.equal((await first.read()).summary.creditAvailable, false);
  assert.equal((await second.read()).summary.credit, null);
});

test('declined or failed batches release the credit, verified batches spend it only once', async () => {
  const journal = new SendJournal(new MemoryJournalAdapter());
  await journal.merge({ ...EMPTY_SEND_SUMMARY, creditAvailable: true, credit });
  await journal.record(intent('declined'), permit('declined'), 'offline');
  await journal.milestone('declined', 'released');
  assert.equal((await journal.read()).summary.creditAvailable, true);
  await journal.record(intent('successful'), permit('successful'), 'offline');
  await journal.milestone('successful', 'verified', event('successful', credit.id));
  await journal.milestone('successful', 'verified', { ...event('successful'), verifiedAt: 300 });
  await journal.milestone('successful', 'released');
  const state = await journal.read();
  assert.equal(state.summary.creditAvailable, false);
  assert.equal(state.operations.successful.status, 'verified');
  assert.equal(state.operations.successful.event?.verifiedAt, 200);
});

test('refresh preserves reservations; a stale server summary cannot restore a reserved or spent credit', async () => {
  const shared = new MemoryJournalAdapter(); const first = new SendJournal(shared);
  await first.merge({ ...EMPTY_SEND_SUMMARY, creditAvailable: true, credit });
  await first.record(intent('reserved'), permit('reserved'), 'offline');
  const refreshed = new SendJournal(shared);
  await refreshed.merge({ ...EMPTY_SEND_SUMMARY, creditAvailable: true, credit });
  assert.equal((await refreshed.read()).summary.creditAvailable, false);
  assert.equal((await refreshed.read()).operations.reserved.credit?.id, credit.id);
});

test('offline sync acknowledgement is idempotent and preserves authoritative pending history', async () => {
  const journal = new SendJournal(new MemoryJournalAdapter());
  await journal.record(intent('offline-one'), permit('offline-one'), 'offline');
  await journal.milestone('offline-one', 'verified', event('offline-one'));
  const summary = { ...EMPTY_SEND_SUMMARY, pendingOfflineAds: 1, pendingOperationIds: ['offline-one'], strictCatchUp: true };
  await journal.merge(summary, ['offline-one']);
  await journal.merge(summary, ['offline-one']);
  const state = await journal.read();
  assert.equal(state.operations['offline-one'].event, undefined);
  assert.equal(state.operations['offline-one'].acknowledged, true);
  assert.equal(state.summary.pendingOfflineAds, 1);
});

test('an operation reference cannot silently change its selected batch', async () => {
  const journal = new SendJournal(new MemoryJournalAdapter());
  await journal.record(intent('same-operation'), permit('same-operation'), 'offline');
  await assert.rejects(journal.record({ ...intent('same-operation'), manifestDigest: 'b'.repeat(64) }, permit('same-operation'), 'offline'), /another selection/);
});

test('a replacement installation never inherits another installation’s credits or offline events', async () => {
  const shared = new MemoryJournalAdapter(); const original = new SendJournal(shared); const replacement = new SendJournal(shared);
  await original.bindInstallation('installation-original');
  await original.merge({ ...EMPTY_SEND_SUMMARY, creditAvailable: true, credit });
  await original.record(intent('old-operation'), permit('old-operation'), 'offline');
  await original.milestone('old-operation', 'verified', event('old-operation', credit.id));
  await replacement.bindInstallation('installation-new');
  assert.equal((await replacement.read()).summary.creditAvailable, false);
  assert.deepEqual((await replacement.read()).operations, {});
  assert.equal(Object.keys((await original.read()).operations).length, 1);
});

test('catch-up progress remains stable across refresh and reduced server requirements', async () => {
  const shared = new MemoryJournalAdapter(); const journal = new SendJournal(shared);
  await journal.record(intent('catch-up-operation'), permit('catch-up-operation'), 'online');
  assert.deepEqual(await journal.progress('catch-up-operation', 4), { total: 4, completed: 0 });
  assert.deepEqual(await journal.progress('catch-up-operation', 3), { total: 4, completed: 1 });
  const refreshed = new SendJournal(shared);
  assert.deepEqual(await refreshed.progress('catch-up-operation', 2), { total: 4, completed: 2 });
});

test('local/server offline counts form an ID union rather than double counting or taking the maximum', async () => {
  const journal = new SendJournal(new MemoryJournalAdapter());
  for (const id of ['overlap', 'local-one', 'local-two']) { await journal.record(intent(id), permit(id), 'offline'); await journal.milestone(id, 'verified', event(id)); }
  await journal.merge({ ...EMPTY_SEND_SUMMARY, pendingOfflineAds: 2, pendingOperationIds: ['overlap', 'server-only'], pendingOperationIdsComplete: true });
  assert.equal(summarizeJournal(await journal.read()).summary.pendingOfflineAds, 4);
});

test('a no-fill result releases its reserved credit without spending it on the free send', async () => {
  const journal = new SendJournal(new MemoryJournalAdapter());
  await journal.merge({ ...EMPTY_SEND_SUMMARY, creditAvailable: true, credit });
  await journal.record(intent('no-fill-operation'), permit('no-fill-operation'), 'offline');
  await journal.unreserveCredit('no-fill-operation');
  await journal.merge({ ...EMPTY_SEND_SUMMARY, creditAvailable: true, credit });
  assert.equal((await journal.read()).summary.creditAvailable, true);
  assert.equal((await journal.read()).operations['no-fill-operation'].credit, null);
});

test('refresh releases only the interrupted tab’s unverified reservations', async () => {
  const journal = new SendJournal(new MemoryJournalAdapter());
  await journal.merge({ ...EMPTY_SEND_SUMMARY, creditAvailable: true, credit });
  await journal.record(intent('refresh-interrupted'), permit('refresh-interrupted'), 'online', credit, false, 'tab-one');
  await journal.record(intent('other-active-tab'), permit('other-active-tab'), 'online', null, false, 'tab-two');
  await journal.record(intent('already-verified'), permit('already-verified'), 'offline', null, false, 'tab-one');
  await journal.milestone('already-verified', 'verified', event('already-verified'));
  const state = await journal.recoverInterrupted('tab-one');
  assert.equal(state.operations['refresh-interrupted'].status, 'released');
  assert.equal(state.operations['other-active-tab'].status, 'prepared');
  assert.equal(state.operations['already-verified'].status, 'verified');
  assert.equal(state.summary.credit?.id, credit.id);
});

test('activating Premium clears unsynced offline history on the installation immediately', async () => {
  const journal = new SendJournal(new MemoryJournalAdapter());
  await journal.record(intent('offline-before-premium'),permit('offline-before-premium'),'offline');
  await journal.milestone('offline-before-premium','verified',event('offline-before-premium'));
  assert.equal(summarizeJournal(await journal.read()).summary.pendingOfflineAds,1);
  await journal.merge({...EMPTY_SEND_SUMMARY,pendingOperationIds:[],pendingOperationIdsComplete:true},[],true);
  const state=await journal.read();
  assert.equal(summarizeJournal(state).summary.pendingOfflineAds,0);
  assert.equal(state.operations['offline-before-premium'].event,undefined);
  assert.equal(state.operations['offline-before-premium'].premiumCovered,true);
});

test('a server-confirmed returned credit is not hidden by an already reconciled retry', async () => {
  const journal=new SendJournal(new MemoryJournalAdapter());
  await journal.merge({...EMPTY_SEND_SUMMARY,creditAvailable:true,credit});
  await journal.record(intent('reconciled-retry'),permit('reconciled-retry'),'online',credit);
  await journal.milestone('reconciled-retry','verified',event('reconciled-retry',credit.id));
  await journal.merge({...EMPTY_SEND_SUMMARY,creditAvailable:true,credit},['reconciled-retry']);
  assert.equal((await journal.read()).summary.creditAvailable,true);
});
