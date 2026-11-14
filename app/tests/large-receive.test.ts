import assert from 'node:assert/strict';
import test from 'node:test';
import {sha256} from '@noble/hashes/sha2.js';
import {ShareClient, type ShareClientOptions} from '../lib/client/controller';
import {GroupShareClient} from '../lib/client/group-controller';
import {StreamingHasher} from '../lib/client/hasher';
import {encodeFrame, MEMORY_FILE_LIMIT, RECEIVE_WINDOW} from '../lib/client/framing';
import {ReceiveFlowBudget} from '../lib/client/receive-flow';
import {trackPreparedArchive} from '../lib/client/archive-storage';
import type {DirectoryHandle} from '../lib/client/sinks';
import type {SendPermit, SendRuntime} from '../lib/market/send-types';
import {MAX_FILE_BYTES} from '../lib/transfer-policy';

type Message = {type: string; id?: string; credit?: number; fileIds?: string[]};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fileInfo(size: number) {return {id: crypto.randomUUID(), name: 'example.bin', size, type: 'application/octet-stream'};}
function metadataFile(size: number) {const file = new File([], 'example.bin'); Object.defineProperty(file, 'size', {value: size}); return file;}

function receiver(options: ShareClientOptions = {}) {
  const client = new ShareClient({isolated: true, ...options}); const messages: Message[] = [];
  Reflect.set(client, 'state', {...client.getSnapshot(), stage: 'connected', sessionId: crypto.randomUUID(), peerName: 'Sender'});
  Reflect.set(client, 'control', {readyState: 'open', send: (raw: string) => {messages.push(JSON.parse(raw));}});
  Reflect.set(client, 'peerFlowControl', true);
  Reflect.set(client, 'hasher', new StreamingHasher());
  return {client, messages,
    offer(files: ReturnType<typeof fileInfo>[]) {
      const batchId = crypto.randomUUID();
      Reflect.set(client, 'state', {...client.getSnapshot(), incomingBatches: [...client.getSnapshot().incomingBatches, {id: batchId, files, peerName: 'Sender', receivedAt: Date.now()}]});
      return batchId;
    },
    handle(message: object) {return (Reflect.get(client, 'handleControl') as (raw: string) => Promise<void>).call(client, JSON.stringify(message));},
    receive(raw: ArrayBuffer) {return (Reflect.get(client, 'receiveFrame') as (raw: unknown) => Promise<void>).call(client, raw);},
  };
}

function fakeDirectory(stream: Partial<FileSystemWritableFileStream> = {}): DirectoryHandle {
  return {name: 'Downloads', async getFileHandle(_name, options) {
    if (!options?.create) throw new DOMException('missing', 'NotFoundError');
    return {async createWritable() {return {write: async () => {}, close: async () => {}, abort: async () => {}, ...stream} as unknown as FileSystemWritableFileStream;}};
  }};
}

function setWindow(value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {value, configurable: true});
  return () => {if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');};
}

test('pair and group selection allow exactly 100 GB per file and reject larger files', () => {
  const pair = new ShareClient({isolated: true});
  const group = new GroupShareClient();
  Reflect.set(group, 'state', {...group.getSnapshot(), groupMode: true});
  for (const client of [pair, group]) {
    client.addFiles([metadataFile(MAX_FILE_BYTES), metadataFile(MAX_FILE_BYTES + 1)]);
    assert.deepEqual(client.getSnapshot().selectedFiles.map(file => file.size), [MAX_FILE_BYTES]);
    assert.equal(client.getSnapshot().errors.length, 1);
    client.clearFiles();
  }
});

test('incoming 100 GB metadata is accepted as an offer, while larger metadata is rejected', async () => {
  const {client, handle} = receiver();
  const file = fileInfo(MAX_FILE_BYTES);
  await handle({type: 'offer', version: 1, batchId: crypto.randomUUID(), files: [file]});
  assert.equal(client.getSnapshot().incomingBatches[0].files[0].size, MAX_FILE_BYTES);
  await assert.rejects(handle({type: 'offer', version: 1, batchId: crypto.randomUUID(), files: [fileInfo(MAX_FILE_BYTES + 1)]}), /Invalid incoming file information/);
  assert.equal(client.getSnapshot().incomingBatches.length, 1);
});

test('Save as obtains a writable destination before sending accept for 100 GB', async () => {
  const fixture = receiver(); const events: string[] = [];
  let choose!: (handle: {createWritable(): Promise<FileSystemWritableFileStream>}) => void;
  const restore = setWindow({showSaveFilePicker: () => {events.push('picker'); return new Promise(resolve => {choose = resolve;});}});
  try {
    Reflect.set(fixture.client, 'state', {...fixture.client.getSnapshot(), capabilities: {...fixture.client.getSnapshot().capabilities, savePicker: true}});
    const file = fileInfo(MAX_FILE_BYTES); const batchId = fixture.offer([file]);
    const accepting = fixture.client.acceptBatch(batchId);
    assert.deepEqual(events, ['picker']);
    assert.equal(fixture.messages.some(message => message.type === 'accept'), false);
    choose({async createWritable() {events.push('writable'); return {write: async () => {}, close: async () => {}, abort: async () => {}} as unknown as FileSystemWritableFileStream;}});
    await accepting;
    assert.deepEqual(events, ['picker', 'writable']);
    assert.equal(fixture.messages.some(message => message.type === 'accept'), true);
    assert.equal(fixture.client.getSnapshot().transfers[0].saveMethod, 'file');
    assert.equal(Reflect.get(fixture.client, 'memoryReserved'), 0);
    fixture.client.cancelTransfer(file.id); await flush();
  } finally {restore();}
});

test('a memory-only receiver rejects 100 GB and retains the pending offer without allocating', async () => {
  const {client, offer, messages} = receiver();
  const batchId = offer([fileInfo(MAX_FILE_BYTES)]);
  await client.acceptBatch(batchId);
  assert.equal(client.getSnapshot().incomingBatches.length, 1);
  assert.equal(client.getSnapshot().transfers.length, 0);
  assert.match(client.getSnapshot().errors[0].message, /cannot safely receive/);
  assert.equal(messages.some(message => message.type === 'accept'), false);
  assert.equal(Reflect.get(client, 'memoryReserved'), 0);
});

test('multiple queued files receive only two active windows per peer from a shared group pool', async () => {
  const pool = new ReceiveFlowBudget(2 * RECEIVE_WINDOW);
  const left = receiver({receiveFlowBudget: pool}); const right = receiver({receiveFlowBudget: pool});
  const peers = [left, right];
  const unsubscribers = peers.map(({client}) => pool.subscribe(() => (Reflect.get(client, 'grantQueuedReceives') as () => void).call(client)));
  const leftFiles = [fileInfo(MAX_FILE_BYTES), fileInfo(MAX_FILE_BYTES), fileInfo(MAX_FILE_BYTES)];
  const rightFiles = [fileInfo(MAX_FILE_BYTES)];
  for (const {client} of peers) Reflect.set(client, 'directory', fakeDirectory());
  try {
    await left.client.acceptBatch(left.offer(leftFiles)); await right.client.acceptBatch(right.offer(rightFiles));
    assert.equal(pool.used, 2 * RECEIVE_WINDOW);
    assert.equal((Reflect.get(left.client, 'receiveWindows') as Map<string, unknown>).size, 2);
    assert.equal((Reflect.get(right.client, 'receiveWindows') as Map<string, unknown>).size, 0);
    assert.equal(left.messages.filter(message => message.type === 'ack' && Number(message.credit) > 0).length, 2);
    left.client.cancelTransfer(leftFiles[0].id); await flush();
    assert.equal((Reflect.get(left.client, 'receiveWindows') as Map<string, unknown>).size, 2, 'next queued file can proceed');
    left.client.cancelTransfer(leftFiles[1].id); await flush();
    assert.equal((Reflect.get(right.client, 'receiveWindows') as Map<string, unknown>).size, 1, 'another peer proceeds when capacity is released');
    assert.equal(pool.used, 2 * RECEIVE_WINDOW);
  } finally {
    for (const file of leftFiles) left.client.cancelTransfer(file.id);
    for (const file of rightFiles) right.client.cancelTransfer(file.id);
    await flush(); unsubscribers.forEach(unsubscribe => unsubscribe());
  }
  assert.equal(pool.used, 0);
});

test('sending data without granted credit fails that file before writing it', async () => {
  const pool = new ReceiveFlowBudget(0); let writes = 0;
  const fixture = receiver({receiveFlowBudget: pool});
  Reflect.set(fixture.client, 'directory', fakeDirectory({write: async () => {writes++;}}));
  const file = fileInfo(MAX_FILE_BYTES); const batchId = fixture.offer([file]);
  await fixture.client.acceptBatch(batchId);
  await fixture.receive(encodeFrame(batchId, file.id, 0, new Uint8Array([1]).buffer));
  assert.equal(writes, 0); assert.equal(pool.used, 0);
  assert.equal(fixture.client.getSnapshot().transfers[0].status, 'failed');
  assert.equal(fixture.messages.some(message => message.type === 'complete'), false);
});

test('disk failure releases the receive window and never reports a successful delivery', async () => {
  const pool = new ReceiveFlowBudget(); let aborted = 0;
  const fixture = receiver({receiveFlowBudget: pool});
  Reflect.set(fixture.client, 'directory', fakeDirectory({write: async () => {throw new DOMException('disk full', 'QuotaExceededError');}, abort: async () => {aborted++;}}));
  const file = fileInfo(MAX_FILE_BYTES); const batchId = fixture.offer([file]);
  await fixture.client.acceptBatch(batchId);
  await fixture.receive(encodeFrame(batchId, file.id, 0, new Uint8Array([1, 2, 3]).buffer));
  assert.equal(fixture.client.getSnapshot().transfers[0].status, 'failed');
  assert.equal(pool.used, 0); assert.equal(aborted, 1);
  assert.equal(fixture.messages.some(message => message.type === 'complete'), false);
});

test('verification is insufficient when closing the destination fails', async () => {
  const fixture = receiver(); let aborted = 0;
  Reflect.set(fixture.client, 'directory', fakeDirectory({close: async () => {throw new Error('could not commit file');}, abort: async () => {aborted++;}}));
  const bytes = new Uint8Array([1, 2, 3]); const file = fileInfo(bytes.byteLength); const batchId = fixture.offer([file]);
  await fixture.client.acceptBatch(batchId); await fixture.receive(encodeFrame(batchId, file.id, 0, bytes.buffer));
  const hash = [...sha256(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  await fixture.handle({type: 'finish', id: file.id, hash});
  assert.equal(fixture.client.getSnapshot().transfers[0].status, 'failed'); assert.equal(aborted, 1);
  assert.equal(fixture.messages.some(message => message.type === 'complete'), false);
});

test('a sender accepts completion only when it matches the file digest', async () => {
  const fixture = receiver(); const file = new File(['hello'], 'hello.txt');
  fixture.client.addFiles([file]); await fixture.client.sendSelected();
  const [fileId, outgoing] = [...(Reflect.get(fixture.client, 'outgoing') as Map<string, {ending: boolean; offset: number; digest: string; status: string}>).entries()][0];
  outgoing.ending = true; outgoing.offset = file.size; outgoing.digest = 'a'.repeat(64); outgoing.status = 'verifying';
  await fixture.handle({type: 'complete', id: fileId, saved: true});
  assert.equal(outgoing.status, 'verifying');
  await fixture.handle({type: 'complete', id: fileId, saved: true, hash: 'b'.repeat(64)});
  assert.equal(outgoing.status, 'verifying');
  await fixture.handle({type: 'complete', id: fileId, saved: true, hash: outgoing.digest});
  assert.equal(outgoing.status, 'saved');
});

test('an ad authorization snapshot retains its prepared source if selection is cleared meanwhile', async () => {
  let authorize!: (permit: SendPermit | null) => void; let requests = 0; let removed = 0;
  const runtime: SendRuntime = {authorize: async () => {requests++; return new Promise(resolve => {authorize = resolve;});}, milestone: async () => {}};
  const {client} = receiver({sendRuntime: runtime});
  Reflect.set(client, 'peerSendPolicy', 2);
  const file = new File(['prepared archive'], 'folder.zip'); trackPreparedArchive(file, async () => {removed++;});
  client.addFiles([file]); const sending = client.sendSelected();
  while (!requests) await flush();
  try {
    client.clearFiles(); await flush();
    assert.equal(removed, 0, 'authorization still owns the immutable original source');
  } finally {authorize(null); await sending; await flush();}
  assert.equal(removed, 1);
});

test('normal small downloads retain the existing bounded memory path', async () => {
  const {client, offer} = receiver(); const file = fileInfo(MEMORY_FILE_LIMIT);
  await client.acceptBatch(offer([file]));
  assert.equal(client.getSnapshot().transfers[0].saveMethod, 'download');
  assert.equal(Reflect.get(client, 'memoryReserved'), MEMORY_FILE_LIMIT);
  client.cancelTransfer(file.id); await flush(); assert.equal(Reflect.get(client, 'memoryReserved'), 0);
});
