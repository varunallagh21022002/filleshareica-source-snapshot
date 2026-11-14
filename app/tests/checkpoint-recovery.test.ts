import assert from 'node:assert/strict';
import test from 'node:test';
import {sha256} from '@noble/hashes/sha2.js';
import {ShareClient} from '../lib/client/controller';
import {StreamingHasher} from '../lib/client/hasher';
import {decodeFrame, encodeFrame} from '../lib/client/framing';
import {SendOperation} from '../lib/client/send-operation';

type Message = Record<string, unknown> & {type: string};
const encoder = new TextEncoder();
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const hash = (text: string) => [...sha256(encoder.encode(text))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const call = <T = void>(client: ShareClient, method: string, ...args: unknown[]): Promise<T> => (Reflect.get(client, method) as (...values: unknown[]) => Promise<T>).apply(client, args);

function fixture() {
  const client = new ShareClient({isolated: true}); const messages: Message[] = []; const frames: ArrayBuffer[] = [];
  const hasher = new StreamingHasher();
  Reflect.set(client, 'state', {...client.getSnapshot(), stage: 'connected', sessionId: crypto.randomUUID(), role: 'host'});
  Reflect.set(client, 'control', {readyState: 'open', send: (raw: string) => {messages.push(JSON.parse(raw));}});
  Reflect.set(client, 'hasher', hasher); Reflect.set(client, 'peerFlowControl', true);
  const attachData = () => Reflect.set(client, 'data', {readyState: 'open', bufferedAmount: 0, send: (raw: ArrayBuffer) => {frames.push(raw);}});
  return {client, messages, frames, hasher, attachData};
}

async function receiverFixture(text = 'abcdef') {
  const setup = fixture();
  const file = {id: crypto.randomUUID(), name: 'recovery.txt', size: encoder.encode(text).length, type: 'text/plain'};
  const batchId = crypto.randomUUID();
  await call(setup.client, 'handleControl', JSON.stringify({type: 'offer', version: 1, batchId, files: [file]}));
  await setup.client.acceptBatch(batchId);
  return {...setup, file, batchId};
}

test('negotiated checkpoint replay uses the written partial file without resetting its writer or hash', async () => {
  const r = await receiverFixture(); const senderTransport = crypto.randomUUID();
  try {
    await call(r.client, 'receiveFrame', encodeFrame(r.batchId, r.file.id, 0, encoder.encode('abc').buffer));
    const before = (Reflect.get(r.client, 'receiving') as Map<string, {sink: unknown}>).get(r.file.id)!.sink;
    Reflect.set(r.client, 'state', {...r.client.getSnapshot(), stage: 'reconnecting'});
    r.attachData(); await call(r.client, 'checkConnected');
    await call(r.client, 'handleControl', JSON.stringify({type: 'hello', version: 1, caps: {flowControl: 1, resumeCheckpoints: 1, transportId: senderTransport}}));
    const checkpoint = r.messages.find(message => message.type === 'checkpoint')!;
    assert.equal(checkpoint.bytes, 3); assert.equal(checkpoint.transportId, senderTransport);
    assert.equal(checkpoint.batchId, r.batchId);
    assert.equal((Reflect.get(r.client, 'receiving') as Map<string, {sink: unknown}>).get(r.file.id)!.sink, before);
    await call(r.client, 'receiveFrame', encodeFrame(r.batchId, r.file.id, 3, encoder.encode('def').buffer));
    await call(r.client, 'handleControl', JSON.stringify({type: 'finish', id: r.file.id, hash: hash('abcdef')}));
    assert.equal(await (Reflect.get(r.client, 'downloads') as Map<string, Blob>).get(r.file.id)!.text(), 'abcdef');
    assert.equal(r.client.getSnapshot().transfers[0].status, 'ready');
  } finally {r.hasher.destroy();}
});

test('replacement transports resume from the receiver checkpoint and rebuild the sender hash prefix', async () => {
  const s = fixture(); const file = new File(['abcdef'], 'recovery.txt');
  try {
    s.client.addFiles([file]); await s.client.sendSelected();
    const [fileId, outgoing] = [...(Reflect.get(s.client, 'outgoing') as Map<string, {id: string; batchId: string; status: string; offset: number; confirmed: number; credit: number; hashStarted: boolean; resumePending: boolean; ending: boolean; digest?: string}>).entries()][0];
    s.hasher.start(fileId); s.hasher.update(fileId, encoder.encode('abcdef').buffer);
    Object.assign(outgoing, {offset: 6, confirmed: 3, credit: 6, status: 'queued', hashStarted: true, resumePending: true});
    Reflect.set(s.client, 'peerCheckpoints', true); s.attachData();
    await call(s.client, 'handleControl', JSON.stringify({type: 'checkpoint', version: 1, transportId: Reflect.get(s.client, 'transportId'), batchId: outgoing.batchId, id: fileId, bytes: 3, credit: 6, paused: false}));
    for (let iteration = 0; iteration < 100 && !outgoing.digest; iteration++) await flush();
    assert.equal(outgoing.digest, hash('abcdef'));
    assert.equal(outgoing.offset, 6); assert.equal(outgoing.resumePending, false);
    assert.equal(s.frames.length, 1);
    const resumed = decodeFrame(s.frames[0]);
    assert.equal(resumed.offset, 3); assert.equal(new TextDecoder().decode(resumed.payload), 'def');
    assert.equal(s.messages.find(message => message.type === 'finish')?.hash, hash('abcdef'));
  } finally {s.hasher.destroy();}
});

test('late or forged checkpoints cannot rewind a live channel or a different transport', async () => {
  const s = fixture();
  try {
    s.client.addFiles([new File(['abcdef'], 'recovery.txt')]); await s.client.sendSelected();
    const [fileId, outgoing] = [...(Reflect.get(s.client, 'outgoing') as Map<string, {batchId: string; offset: number; confirmed: number; credit: number; status: string; resumePending: boolean}>).entries()][0];
    Object.assign(outgoing, {offset: 6, confirmed: 3, credit: 6, status: 'queued', resumePending: true});
    Reflect.set(s.client, 'peerCheckpoints', true);
    const checkpoint = {type: 'checkpoint', version: 1, transportId: Reflect.get(s.client, 'transportId'), batchId: outgoing.batchId, id: fileId, bytes: 2, credit: 6, paused: false};
    await call(s.client, 'handleControl', JSON.stringify(checkpoint));
    await call(s.client, 'handleControl', JSON.stringify({...checkpoint, bytes: 3, transportId: crypto.randomUUID()}));
    await call(s.client, 'handleControl', JSON.stringify({...checkpoint, bytes: 7}));
    assert.equal(outgoing.offset, 6); assert.equal(outgoing.confirmed, 3); assert.equal(outgoing.resumePending, true);
    outgoing.resumePending = false;
    await call(s.client, 'handleControl', JSON.stringify({...checkpoint, bytes: 3}));
    assert.equal(outgoing.offset, 6, 'ordered RTC channels retain in-flight bytes during an ordinary ICE outage');
  } finally {s.hasher.destroy();}
});

test('lost finish and complete controls are replayed without duplicate verification or accounting', async () => {
  const r = await receiverFixture('abc'); const s = fixture(); const milestones: string[] = [];
  try {
    Reflect.set(r.client, 'peerCheckpoints', true); Reflect.set(r.client, 'peerTransportId', Reflect.get(s.client, 'transportId'));
    await call(r.client, 'receiveFrame', encodeFrame(r.batchId, r.file.id, 0, encoder.encode('abc').buffer));
    const digest = hash('abc');
    const operation = new SendOperation({operationId: crypto.randomUUID(), sessionId: 'test', recipientIds: ['peer'], manifestDigest: '', files: [{id: r.file.id, size: 3}]}, null, {authorize: async () => null, milestone: async event => {milestones.push(event.status);}});
    operation.expect(`${s.client.getSnapshot().sessionId}:${r.file.id}`); operation.seal();
    (Reflect.get(s.client, 'outgoing') as Map<string, unknown>).set(r.file.id, {id: r.file.id, batchId: r.batchId, file: new File(['abc'], 'recovery.txt'), operation, offset: 3, confirmed: 0, credit: 3, status: 'verifying', ending: true, digest, localPaused: false, remotePaused: false});
    Reflect.set(s.client, 'peerCheckpoints', true); Reflect.set(s.client, 'peerTransportId', Reflect.get(r.client, 'transportId'));
    await call(s.client, 'replayCheckpoints', Reflect.get(r.client, 'transportId'));
    const finish = s.messages.find(message => message.type === 'finish')!;
    await call(r.client, 'handleControl', JSON.stringify(finish));
    const complete = r.messages.find(message => message.type === 'complete')!;
    assert.equal(complete.hash, digest);
    // The first receipt is lost. A later replay must not re-close the file or re-hash it.
    await call(r.client, 'handleControl', JSON.stringify(finish));
    assert.equal(r.messages.filter(message => message.type === 'complete').length, 2);
    await call(r.client, 'replayCheckpoints', Reflect.get(s.client, 'transportId'));
    assert.equal(r.messages.filter(message => message.type === 'complete').length, 3);
    await call(s.client, 'handleControl', JSON.stringify(complete));
    await call(s.client, 'handleControl', JSON.stringify(complete));
    assert.deepEqual(milestones, ['verified']);
  } finally {r.hasher.destroy(); s.hasher.destroy();}
});

test('older hello messages do not enable checkpoint controls', async () => {
  const r = await receiverFixture('abc');
  try {
    await call(r.client, 'receiveFrame', encodeFrame(r.batchId, r.file.id, 0, encoder.encode('a').buffer));
    await call(r.client, 'handleControl', JSON.stringify({type: 'hello', version: 1, memoryLimit: 64 * 1024 * 1024}));
    assert.equal(Reflect.get(r.client, 'peerCheckpoints'), false);
    assert.equal(r.messages.some(message => message.type === 'checkpoint'), false);
    assert.equal(r.client.getSnapshot().transfers[0].status, 'transferring');
  } finally {r.hasher.destroy();}
});

test('dead data channels replace the transport at the same revision and preserve file state', async () => {
  const s = fixture(); const previous = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection'); const signals: {type: string; replace?: boolean}[] = [];
  class ReplacementPeer {
    connectionState = 'new';
    createDataChannel(label: string) {return {label, readyState: 'connecting', close() {}};}
    async createOffer() {return {type: 'offer' as const, sdp: 'replacement'};}
    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', {configurable: true, value: ReplacementPeer});
  try {
    s.client.addFiles([new File(['abcdef'], 'recovery.txt')]); await s.client.sendSelected();
    const outgoing = [...(Reflect.get(s.client, 'outgoing') as Map<string, {id: string; offset: number; confirmed: number; resumePending: boolean}>).values()][0];
    outgoing.offset = 6; outgoing.confirmed = 3;
    s.hasher.start(outgoing.id); s.hasher.update(outgoing.id, encoder.encode('abcdef').buffer);
    const oldPeer = {close() {}};
    Reflect.set(s.client, 'pc', oldPeer); Reflect.set(s.client, 'hadConnected', true); Reflect.set(s.client, 'peerCheckpoints', true);
    Reflect.set(s.client, 'sendSignal', async (signal: {type: string; replace?: boolean}) => {signals.push(signal);});
    await call(s.client, 'replaceTransport', true);
    assert.notEqual(Reflect.get(s.client, 'pc'), oldPeer);
    assert.equal(Reflect.get(s.client, 'connectionRevision'), 0);
    assert.equal(outgoing.resumePending, true); assert.equal(outgoing.offset, 6); assert.equal(outgoing.confirmed, 3);
    assert.equal(await s.hasher.finish(outgoing.id), hash('abcdef'), 'same-page hash state survives transport replacement');
    assert.deepEqual(signals.map(signal => [signal.type, signal.replace]), [['restart', true], ['description', undefined]]);
  } finally {
    await call(s.client, 'closePeer'); s.hasher.destroy();
    if (previous) Object.defineProperty(globalThis, 'RTCPeerConnection', previous); else Reflect.deleteProperty(globalThis, 'RTCPeerConnection');
  }
});
