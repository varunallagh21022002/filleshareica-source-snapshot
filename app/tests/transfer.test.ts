import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInvitationSecret, deriveSignalKey, encryptSignal, fromBase64Url, invitationHash, parseInvitation, SignalDecryptor } from '../lib/client/crypto';
import { decodeFrame, encodeFrame, FRAME_HEADER, MAX_CHUNK } from '../lib/client/framing';
import { StreamingHasher } from '../lib/client/hasher';
import { memorySink, safeFilename } from '../lib/client/sinks';
import { clearSavedSession, readSavedSession, saveSession, SESSION_STORAGE_KEY, type SavedShareSession } from '../lib/client/session-storage';
import { receiverCapability, ShareClient } from '../lib/client/controller';
const batch = '01234567-89ab-4cde-8f01-23456789abcd';
const file = '12345678-9abc-4def-9012-3456789abcde';

test('binary frames preserve IDs, large offsets, and file payload', () => {
  const input = crypto.getRandomValues(new Uint8Array(48 * 1024));
  const frame = encodeFrame(batch, file, 10 * 1024 ** 3, input.buffer);
  assert.equal(frame.byteLength, input.byteLength + FRAME_HEADER);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.batchId, batch); assert.equal(decoded.fileId, file);
  assert.equal(decoded.offset, 10 * 1024 ** 3); assert.deepEqual(decoded.payload, input);
});
test('binary frames reject corrupt headers, truncation, unsafe offsets and oversized chunks', () => {
  assert.throws(() => decodeFrame(new ArrayBuffer(2)), /Truncated/);
  assert.throws(() => encodeFrame(batch, file, -1, new ArrayBuffer(0)), /Invalid/);
  assert.throws(() => encodeFrame(batch, file, 0, new ArrayBuffer(MAX_CHUNK + 1)), /Invalid/);
  assert.throws(() => encodeFrame('wrong', file, 0, new ArrayBuffer(0)), /identifier/);
  const frame = encodeFrame(batch, file, 0, new ArrayBuffer(4));
  new DataView(frame).setUint32(44, 8); assert.throws(() => decodeFrame(frame), /Invalid/);
});
test('invitation secrets are 256-bit and join hash matches backend hexadecimal contract', async () => {
  const secret = createInvitationSecret(); assert.equal(fromBase64Url(secret).byteLength, 32);
  assert.match(await invitationHash(secret), /^[0-9a-f]{64}$/);
  assert.deepEqual(parseInvitation(`https://share.test/?session=abcdefghijklmnop#key=${secret}`, 'https://share.test'), {sessionId: 'abcdefghijklmnop', secret});
  assert.throws(() => parseInvitation(`https://other.test/?session=abcdefghijklmnop#key=${secret}`, 'https://share.test'), /different website/);
  assert.throws(() => parseInvitation('https://share.test/?session=abcdefghijklmnop', 'https://share.test'), /incomplete/);
});
test('named invitations carry the same private key without a session query parameter', () => {
  const secret = createInvitationSecret();
  assert.deepEqual(parseInvitation(`https://share.test/s/weekend-photos-4a2f99#key=${secret}`, 'https://share.test'), {sessionId: 'weekend-photos-4a2f99', secret});
  assert.throws(() => parseInvitation('https://share.test/s/weekend-photos-4a2f99', 'https://share.test'), /incomplete/);
  assert.throws(() => parseInvitation(`https://share.test/s/../../bad#key=${secret}`, 'https://share.test'), /incomplete/);
});
test('tab session persistence preserves approval credentials and contains no file payloads', () => {
  const values = new Map<string, string>();
  const storage = {getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
  const session: SavedShareSession = {version: 1, sessionId: batch, token: 'a'.repeat(64), secret: createInvitationSecret(), role: 'guest', slug: 'my-photos-123abc', sessionName: 'My photos', expiresAt: Date.now() + 60_000, connectionRevision: 3, hadConnected: true, pendingTransfers: true};
  saveSession(storage, session);
  assert.deepEqual(readSavedSession(storage), session);
  storage.setItem(SESSION_STORAGE_KEY, '{not json'); assert.equal(readSavedSession(storage), null);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({...session, token: 'invalid'})); assert.equal(readSavedSession(storage), null);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({...session, secret: 'short'})); assert.equal(readSavedSession(storage), null);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({...session, connectionRevision: -1})); assert.equal(readSavedSession(storage), null);
  saveSession(storage, session); clearSavedSession(storage); assert.equal(readSavedSession(storage), null);
  const disabledStorage = {getItem: () => {throw new Error('blocked');}, setItem: () => {throw new Error('blocked');}, removeItem: () => {throw new Error('blocked');}};
  assert.equal(readSavedSession(disabledStorage), null); assert.doesNotThrow(() => saveSession(disabledStorage, session)); assert.doesNotThrow(() => clearSavedSession(disabledStorage));
});
test('authenticated signaling encrypts, detects replays and rejects wrong room or key', async () => {
  const secret = createInvitationSecret(); const room = 'abcdefghijklmnop';
  const key = await deriveSignalKey(secret, room);
  const message = {type: 'description', description: {type: 'offer', sdp: 'private SDP fingerprint'}};
  const encrypted = await encryptSignal(key, room, 'host', batch, 1, message);
  assert.ok(!encrypted.includes('private SDP'));
  const reader = new SignalDecryptor(key, room, 'guest');
  assert.deepEqual(await reader.decrypt(encrypted), message);
  await assert.rejects(reader.decrypt(encrypted), /Repeated/);
  await assert.rejects(new SignalDecryptor(key, 'wrong-room', 'guest').decrypt(encrypted));
  const other = await deriveSignalKey(createInvitationSecret(), room);
  await assert.rejects(new SignalDecryptor(other, room, 'guest').decrypt(encrypted));
  await assert.rejects(new SignalDecryptor(key, room, 'host').decrypt(encrypted), /Invalid/);
  const tampered = JSON.parse(encrypted); tampered.sequence = 99;
  await assert.rejects(new SignalDecryptor(key, room, 'guest').decrypt(JSON.stringify(tampered)));
});
test('incremental SHA256 verifies many chunks and the empty file', async () => {
  const hasher = new StreamingHasher(); hasher.start(file);
  hasher.update(file, new TextEncoder().encode('a').buffer); hasher.update(file, new TextEncoder().encode('bc').buffer);
  await hasher.flush(file);
  assert.equal(await hasher.finish(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  hasher.start(batch); assert.equal(await hasher.finish(batch), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  hasher.destroy();
});
test('memory receive sink preserves data and safe filenames do not contain path traversal', async () => {
  const sink = memorySink('text/plain'); await sink.write(new TextEncoder().encode('hello ')); await sink.write(new TextEncoder().encode('world'));
  assert.equal(await (await sink.close())?.text(), 'hello world');
  assert.equal(safeFilename('../a\\b\0.txt'), '.._a_b_.txt'); assert.equal(safeFilename('...'), '_');
});
test('a delayed receive commit cannot revive an interrupted transfer after reconnection', async () => {
  const client = new ShareClient(); const hash = 'a'.repeat(64); const sent: string[] = [];
  let closeStarted!: () => void; const closing = new Promise<void>(resolve => {closeStarted = resolve;});
  let completeClose!: (blob: Blob) => void; const closed = new Promise<Blob>(resolve => {completeClose = resolve;});
  const item = {id: file, batchId: batch, info: {id: file, name: 'pending.txt', size: 3, type: 'text/plain'}, bytes: 3, status: 'transferring', localPaused: false, remotePaused: false, sink: Promise.resolve({write: async () => {}, close: () => {closeStarted(); return closed;}, abort: async () => {}}), directory: null, started: 1, lastAck: 3, lastAckTime: 1, sampled: 1, sampledBytes: 3, expectedHash: hash, finishing: false, hasherStarted: true};
  Reflect.set(client, 'hasher', {finish: async () => hash, cancel: () => {}});
  Reflect.set(client, 'control', {readyState: 'open', send: (message: string) => sent.push(message)});
  Reflect.set(client, 'state', {...client.getSnapshot(), transfers: [{...item.info, batchId: batch, direction: 'incoming', status: 'transferring', bytes: 3, speed: 0, averageSpeed: 0, remainingSeconds: null}]});
  (Reflect.get(client, 'receiving') as Map<string, unknown>).set(file, item);
  const finish = Reflect.get(client, 'finishIncoming') as (item: unknown) => Promise<void>;
  const committing = finish.call(client, item); await closing;
  const changeRevision = Reflect.get(client, 'adoptConnectionRevision') as (revision: number) => Promise<void>;
  await changeRevision.call(client, 1); completeClose(new Blob(['abc'])); await committing;
  assert.equal(client.getSnapshot().transfers[0].status, 'failed');
  assert.equal((Reflect.get(client, 'downloads') as Map<string, Blob>).size, 0);
  assert.equal(sent.length, 0);
});

test('expired signaling preserves healthy data channels without polling or restoring expired credentials', async () => {
  const originalFetch = globalThis.fetch; const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    for (const status of [404, 410]) {
      const values = new Map([[SESSION_STORAGE_KEY, 'old resume credentials']]);
      Object.defineProperty(globalThis, 'window', {configurable: true, value: {sessionStorage: {getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}}}});
      const client = new ShareClient(); let fetches = 0; let closed = 0;
      const peer = {connectionState: 'connected', close: () => {closed++;}};
      const control = {label: 'f8-control', readyState: 'open', send: () => {}};
      const data = {label: 'f8-data', readyState: 'open', onclose: null as (() => void) | null};
      Reflect.set(client, 'state', {...client.getSnapshot(), stage: 'connected', sessionId: batch, role: 'host', sessionSlug: 'test-123456'});
      Reflect.set(client, 'token', 'a'.repeat(64)); Reflect.set(client, 'secret', createInvitationSecret()); Reflect.set(client, 'pc', peer);
      const attach = Reflect.get(client, 'attachChannel') as (channel: unknown) => void;
      attach.call(client, control); attach.call(client, data);
      globalThis.fetch = async () => {fetches++; return new Response(JSON.stringify({error: 'Session expired.'}), {status, headers: {'Content-Type': 'application/json'}});};
      const poll = Reflect.get(client, 'poll') as () => Promise<void>; await poll.call(client);
      assert.equal(client.getSnapshot().stage, 'connected'); assert.equal(Reflect.get(client, 'pc'), peer); assert.equal(closed, 0);
      assert.equal(values.has(SESSION_STORAGE_KEY), false);
      assert.match(client.getSnapshot().errors[0].message, /current connection and transfers continue/);
      const schedule = Reflect.get(client, 'schedulePoll') as (delay: number) => void; schedule.call(client, 0);
      await poll.call(client); await new Promise(resolve => setTimeout(resolve, 5));
      const persist = Reflect.get(client, 'persistSession') as () => void; persist.call(client);
      assert.equal(fetches, 1); assert.equal(Reflect.get(client, 'timer'), null); assert.equal(values.has(SESSION_STORAGE_KEY), false);
      data.onclose!();
      assert.equal(client.getSnapshot().stage, 'closed'); assert.equal(closed, 1);
      assert.match(client.getSnapshot().errors.at(-1)!.message, /Create a new pairing/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('an explicit server-closed session still closes healthy data channels', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const client = new ShareClient(); let closed = 0;
    Reflect.set(client, 'state', {...client.getSnapshot(), stage: 'connected', sessionId: batch, role: 'host'});
    Reflect.set(client, 'pc', {connectionState: 'connected', close: () => {closed++;}});
    Reflect.set(client, 'control', {readyState: 'open'}); Reflect.set(client, 'data', {readyState: 'open'});
    globalThis.fetch = async () => new Response(JSON.stringify({status: 'closed', connectionRevision: 0, expiresAt: Date.now(), iceServers: [], relayAvailable: false, signals: []}), {headers: {'Content-Type': 'application/json'}});
    const poll = Reflect.get(client, 'poll') as () => Promise<void>; await poll.call(client);
    assert.equal(client.getSnapshot().stage, 'closed'); assert.equal(closed, 1); assert.equal(Reflect.get(client, 'pc'), null);
    assert.equal(Reflect.get(client, 'signalingUnavailable'), false);
  } finally {globalThis.fetch = originalFetch;}
});

test('ending a waiting pair cannot recreate cleared refresh credentials during peer cleanup', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history'); const originalFetch = globalThis.fetch;
  const values = new Map<string, string>(); let cleared = false; let writesAfterClear = 0; let leaveRequests = 0;
  const storage = {getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => {if (cleared) writesAfterClear++; values.set(key, value);}, removeItem: (key: string) => {values.delete(key); cleared = true;}};
  try {
    Object.defineProperty(globalThis, 'window', {configurable: true, value: {sessionStorage: storage}});
    Object.defineProperty(globalThis, 'history', {configurable: true, value: {replaceState: () => {}}});
    globalThis.fetch = async input => {if (String(input).endsWith('/leave')) leaveRequests++; return new Response('{}');};
    const client = new ShareClient();
    Reflect.set(client, 'state', {...client.getSnapshot(), stage: 'waiting', sessionId: batch, sessionSlug: '123abc', role: 'host', expiresAt: Date.now() + 60_000});
    Reflect.set(client, 'token', 'a'.repeat(64)); Reflect.set(client, 'secret', createInvitationSecret());
    const persist = Reflect.get(client, 'persistSession') as () => void;
    persist.call(client); assert.equal(values.has(SESSION_STORAGE_KEY), true);
    // closePeer emits access-state cleanup before disconnect emits its idle state.
    // Both notifications must already have their persistence inputs revoked.
    client.subscribe(() => persist.call(client));
    await client.endSession(); persist.call(client);
    assert.equal(client.getSnapshot().stage, 'idle'); assert.equal(client.getSnapshot().sessionId, null);
    assert.equal(values.has(SESSION_STORAGE_KEY), false); assert.equal(writesAfterClear, 0); assert.equal(leaveRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory); else Reflect.deleteProperty(globalThis, 'history');
  }
});


test('optional hello capabilities accept older peers and distinguish available from selected folder storage', () => {
  assert.equal(receiverCapability({type: 'hello', version: 1}, 'Old browser'), null);
  const old = receiverCapability({memoryLimit: 64 * 1024 ** 2, folder: true}, 'Desktop');
  assert.equal(old?.pendingDownloadLimit, 64 * 1024 ** 2); assert.equal(old?.folderAccessAvailable, true); assert.equal(old?.folderDestinationSelected, false);
  const current = receiverCapability({caps: {platform: 'browser', pendingDownloadLimit: 64 * 1024 ** 2, folderAccessAvailable: true, folderDestinationSelected: true, archiveFormat: 'zip64'}}, 'Desktop');
  assert.equal(current?.folderDestinationSelected, true); assert.equal(current?.archiveFormat, 'zip64');
  const invalid = receiverCapability({memoryLimit: -1, caps: {platform: 'anything', folderDestinationSelected: true}}, 'Unknown');
  assert.equal(invalid?.pendingDownloadLimit, null); assert.equal(invalid?.folderDestinationSelected, false); assert.equal(invalid?.platform, 'unknown');
});
