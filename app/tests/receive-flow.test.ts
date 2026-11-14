import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_RECEIVE_BUDGET_BYTES, MAX_RECEIVE_WINDOW_BYTES, RECEIVE_QUEUE_SLACK_BYTES, ReceiveFlowBudget} from '../lib/client/receive-flow';

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('multiple peers share a bounded receive budget and owners reserve once', () => {
  const budget = new ReceiveFlowBudget();
  const owners = Array.from({length: 9}, () => ({}));
  for (const owner of owners.slice(0, 8)) assert.equal(budget.acquire(owner, MAX_RECEIVE_WINDOW_BYTES), true);
  assert.equal(budget.used, DEFAULT_RECEIVE_BUDGET_BYTES);
  assert.equal(budget.available, 0);
  assert.equal(budget.acquire(owners[8], 1), false);
  assert.equal(budget.acquire(owners[0], MAX_RECEIVE_WINDOW_BYTES), true);
  assert.equal(budget.acquire(owners[0], 1), false);
  assert.equal(budget.used, DEFAULT_RECEIVE_BUDGET_BYTES);
  budget.release(owners[0]);
  budget.release(owners[0]);
  assert.equal(budget.acquire(owners[8], MAX_RECEIVE_WINDOW_BYTES), true);
  for (const owner of owners) budget.release(owner);
  assert.equal(budget.used, 0);
  assert.equal(budget.available, DEFAULT_RECEIVE_BUDGET_BYTES);
});

test('release coalesces asynchronous notifications and unsubscribed peers stay asleep', async () => {
  const budget = new ReceiveFlowBudget(32);
  const a = {}, b = {};
  let notifications = 0;
  const unsubscribe = budget.subscribe(() => { notifications++; });
  budget.acquire(a, 16); budget.acquire(b, 16);
  budget.release(a); budget.release(b);
  assert.equal(notifications, 0);
  await flush(); assert.equal(notifications, 1);
  budget.acquire(a, 32); budget.release(a); unsubscribe();
  await flush(); assert.equal(notifications, 1);
  budget.release({}); await flush(); assert.equal(notifications, 1);
});

test('waiting peers rotate first opportunity without a polling timer', async () => {
  const budget = new ReceiveFlowBudget(16);
  const peers = [{name: 'phone', owner: {}}, {name: 'desktop', owner: {}}, {name: 'tablet', owner: {}}];
  const wins: string[] = [];
  let current: object | null = null;
  for (const peer of peers) budget.subscribe(() => {
    if (current !== peer.owner && budget.acquire(peer.owner, 16)) { current = peer.owner; wins.push(peer.name); }
  });
  const blocker = {}; budget.acquire(blocker, 16); budget.release(blocker);
  await flush(); assert.deepEqual(wins, ['phone']);
  budget.release(current!); current = null;
  await flush(); assert.deepEqual(wins, ['phone', 'desktop']);
  budget.release(current!); current = null;
  await flush(); assert.deepEqual(wins, ['phone', 'desktop', 'tablet']);
  assert.equal(budget.used, 16);
});

test('zero-size reservations are idempotent and cannot cause release notification loops', async () => {
  const budget = new ReceiveFlowBudget(0);
  const owner = {}; let calls = 0;
  budget.subscribe(() => { calls++; budget.acquire(owner, 0); budget.release(owner); });
  assert.equal(budget.acquire(owner, 0), true);
  assert.equal(budget.acquire(owner, 0), true);
  assert.equal(budget.acquire(owner, 1), false);
  budget.release(owner); await flush();
  assert.equal(calls, 0); assert.equal(budget.used, 0);
});

test('raw frame queues have header slack, reject overflow and preserve peak usage', () => {
  const budget = new ReceiveFlowBudget(128);
  const cap = 128 + RECEIVE_QUEUE_SLACK_BYTES;
  assert.equal(budget.enqueue(cap - 1), true);
  assert.equal(budget.enqueue(1), true);
  assert.equal(budget.enqueue(1), false);
  assert.equal(budget.queuedBytes, cap);
  assert.equal(budget.peakQueuedBytes, cap);
  assert.equal(budget.used, 0);
  budget.dequeue(cap); assert.equal(budget.queuedBytes, 0);
  assert.equal(budget.peakQueuedBytes, cap);
  assert.equal(budget.enqueue(128), true);
  budget.dequeue(128); budget.dequeue(0);
  assert.throws(() => budget.dequeue(1), RangeError);
  assert.equal(budget.queuedBytes, 0);
});

test('invalid counts and oversized reservation windows never alter accounting', () => {
  const budget = new ReceiveFlowBudget(); const owner = {};
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(budget.acquire(owner, invalid), false);
    assert.equal(budget.enqueue(invalid), false);
    assert.throws(() => budget.dequeue(invalid), RangeError);
    assert.throws(() => new ReceiveFlowBudget(invalid), RangeError);
  }
  assert.equal(budget.acquire(owner, MAX_RECEIVE_WINDOW_BYTES + 1), false);
  assert.throws(() => new ReceiveFlowBudget(Number.MAX_SAFE_INTEGER), RangeError);
  assert.equal(budget.used, 0); assert.equal(budget.queuedBytes, 0);
  assert.equal(budget.acquire(owner, MAX_RECEIVE_WINDOW_BYTES), true);
  budget.release(owner); assert.equal(budget.available, DEFAULT_RECEIVE_BUDGET_BYTES);
});
