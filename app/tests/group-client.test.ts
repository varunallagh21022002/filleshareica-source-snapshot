import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GroupShareClient} from '../lib/client/group-controller';
import {ShareClient, defaultShareState, validChat, sessionPath} from '../lib/client/controller';
import {clearSavedGroup, GROUP_STORAGE_KEY, readSavedGroup, saveGroup, type SavedGroup} from '../lib/client/group-storage';
import {createInvitationSecret} from '../lib/client/crypto';
import type {SendIntent, SendPermit, SendRuntime} from '../lib/market/send-types';
import type {SendOperation} from '../lib/client/send-operation';

const self = '00000000-0000-4000-a000-000000000001';
const alice = '00000000-0000-4000-a000-000000000002';
const bob = '00000000-0000-4000-a000-000000000003';
const members = [
  {id: self, name: 'Host', role: 'host', status: 'approved'},
  {id: alice, name: 'Alice', role: 'guest', status: 'approved'},
  {id: bob, name: 'Bob', role: 'guest', status: 'approved'},
];
function groupFixture(options: {sendRuntime?: SendRuntime} = {}) {
  const client = new GroupShareClient(options);
  Reflect.set(client, 'state', {...defaultShareState(), stage: 'connected', groupMode: true, selfId: self, members});
  const messages = new Map<string, unknown[]>(); const files = new Map<string, File[]>();
  const peers = new Map();
  for (const memberId of [alice, bob]) {
    messages.set(memberId, []); files.set(memberId, []);
    peers.set(memberId, {sessionId: memberId, unsubscribe: () => {}, client: {
      getSnapshot: () => ({...defaultShareState(), stage: 'connected'}),
      getFileBlockReason: () => null,
      sendChatMessage: (message: unknown) => {messages.get(memberId)!.push(message); return true;},
      addFiles: (incoming: File[]) => {files.get(memberId)!.push(...incoming);},
      sendSelected: async () => {}, syncSettings: () => {}, destroy: () => {},
      sendAuthorized: async (_operation: unknown, incoming: {file: File}[]) => {files.get(memberId)!.push(...incoming.map(snapshot => snapshot.file)); return true;},
      sendGroupEvent: () => true,
    }});
  }
  Reflect.set(client, 'peers', peers);
  return {client, messages, files, peers};
}

test('group tab restoration validates credentials and rejects malformed records', () => {
  const values = new Map<string, string>();
  const storage = {getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
  const group: SavedGroup = {version: 1, groupId: self, code: '123abc', memberId: alice, role: 'guest', token: 'a'.repeat(64), secret: createInvitationSecret(), sessionName: 'My group', expiresAt: Date.now() + 60_000, pendingTransfers: true};
  saveGroup(storage, group); assert.deepEqual(readSavedGroup(storage), group);
  for (const patch of [{token: 'bad'}, {code: 'long-slug-123abc'}, {memberId: 'bad'}, {secret: 'short'}, {pendingTransfers: 'true'}, {sessionName: null}]) {
    storage.setItem(GROUP_STORAGE_KEY, JSON.stringify({...group, ...patch})); assert.equal(readSavedGroup(storage), null);
  }
  saveGroup(storage, group); clearSavedGroup(storage); assert.equal(readSavedGroup(storage), null);
});

test('group fanout authorizes one frozen operation, shares file IDs, and excludes later recipients', async () => {
  const intents: SendIntent[] = []; const milestones: string[] = []; let authorize!: (permit: SendPermit | null) => void;
  const runtime: SendRuntime = {authorize: async intent => {intents.push(intent); return new Promise(resolve => {authorize = resolve;});}, milestone: async event => {milestones.push(event.status);}};
  const {client, peers} = groupFixture({sendRuntime: runtime});
  Reflect.set(client, 'state', {...client.getSnapshot(), sessionId: self});
  const operations: SendOperation[] = []; const captured: {peer: string; id: string; name: string}[] = [];
  for (const [peerId, peer] of peers) peer.client.sendAuthorized = async (operation: SendOperation, files: {info: {id: string; name: string}}[]) => {
    operations.push(operation); for (const file of files) {operation.expect(`${peerId}:${file.info.id}`); captured.push({peer: peerId, id: file.info.id, name: file.info.name});} return true;
  };
  client.addFiles([new File(['original'], 'original.txt')]); const sending = client.sendSelected('all');
  while (!intents.length) await new Promise(resolve => setTimeout(resolve, 0));
  await client.sendSelected('all'); assert.equal(intents.length, 1); assert.equal(captured.length, 0);
  client.addFiles([new File(['later'], 'later.txt')]);
  Reflect.set(client, 'state', {...client.getSnapshot(), members: [...client.getSnapshot().members, {id: crypto.randomUUID(), name: 'Joined later', role: 'guest', status: 'approved'}]});
  authorize({policyVersion: 2, operationId: intents[0].operationId, sessionId: self, manifestDigest: intents[0].manifestDigest, recipientIds: intents[0].recipientIds, senderInstallationId: 'test-installation', decision: 'offline', issuedAt: Date.now(), expiresAt: Date.now() + 60_000, proof: null});
  await sending;
  assert.equal(operations.length, 2); assert.equal(operations[0], operations[1]); assert.equal(captured[0].id, captured[1].id);
  assert.deepEqual(captured.map(file => file.peer), [alice, bob]); assert.deepEqual(captured.map(file => file.name), ['original.txt', 'original.txt']);
  assert.deepEqual(client.getSnapshot().selectedFiles.map(file => file.name), ['later.txt']);
  operations[0].outcome(`${alice}:${captured[0].id}`, 'verified'); operations[1].outcome(`${bob}:${captured[1].id}`, 'released');
  assert.deepEqual(milestones, ['verified']);
});

test('private files and chat go only to their selected member; everyone fans out once per approved member', async () => {
  const {client, messages, files} = groupFixture();
  client.setRecipient(alice); client.addFiles([new File(['private'], 'private.txt')]); await client.sendSelected();
  assert.equal(files.get(alice)!.length, 1); assert.equal(files.get(bob)!.length, 0);
  await client.sendChat('Only Alice'); assert.equal(messages.get(alice)!.length, 1); assert.equal(messages.get(bob)!.length, 0);
  client.setRecipient('all'); client.addFiles([new File(['public'], 'everyone.txt')]); await client.sendSelected();
  await client.sendChat('Everyone');
  assert.deepEqual(files.get(alice)!.map(file => file.name), ['private.txt', 'everyone.txt']);
  assert.deepEqual(files.get(bob)!.map(file => file.name), ['everyone.txt']);
  assert.equal(messages.get(alice)!.length, 2); assert.equal(messages.get(bob)!.length, 1);
  assert.equal(client.getSnapshot().selectedFiles.length, 0);
  assert.equal(client.getSnapshot().chatMessages.length, 2);
});

test('chat is bounded plain text, attributed to the authenticated peer, deduplicated and rate limited', async () => {
  const {client} = groupFixture();
  assert.equal(validChat({id: self, text: '<script>raw text</script>', sentAt: Date.now(), recipient: 'all'}), true);
  assert.equal(validChat({id: self, text: 'a'.repeat(4001), sentAt: Date.now(), recipient: 'all'}), false);
  assert.equal(validChat({id: 'bad', text: 'hi', sentAt: Date.now(), recipient: 'all'}), false);
  const receive = Reflect.get(client, 'receiveChat') as (peerId: string, message: unknown) => void;
  const message = {id: self, text: '<script>hello</script>', sentAt: Date.now(), recipient: 'all', senderId: bob};
  receive.call(client, alice, message); receive.call(client, alice, message);
  assert.equal(client.getSnapshot().chatMessages.length, 1);
  assert.equal(client.getSnapshot().chatMessages[0].senderId, alice);
  assert.equal(client.getSnapshot().chatMessages[0].text, '<script>hello</script>');
  receive.call(client, bob, {...message, id: bob, recipient: alice});
  assert.equal(client.getSnapshot().chatMessages.length, 1);
  for (let index = 0; index < 40; index++) receive.call(client, alice, {...message, id: crypto.randomUUID()});
  assert.ok(client.getSnapshot().chatMessages.length <= 30);
});

test('one group receive budget prevents concurrent peer accepts from multiplying memory capacity', async () => {
  const budget = {used: 0, limit: 64 * 1024 * 1024};
  const left = new ShareClient({isolated: true, receiveBudget: budget});
  const right = new ShareClient({isolated: true, receiveBudget: budget});
  function offer(client: ShareClient, fileId: string, batchId: string) {
    Reflect.set(client, 'state', {...client.getSnapshot(), incomingBatches: [{id: batchId, peerName: 'Device', receivedAt: Date.now(), files: [{id: fileId, name: 'large.bin', size: 40 * 1024 * 1024, type: 'application/octet-stream'}]}]});
  }
  offer(left, self, alice); offer(right, bob, self);
  await Promise.all([left.acceptBatch(alice), right.acceptBatch(self)]);
  assert.equal(budget.used, 40 * 1024 * 1024);
  assert.equal(left.getSnapshot().transfers.length + right.getSnapshot().transfers.length, 1);
  assert.match(right.getSnapshot().errors[0].message, /cannot safely receive|64 MiB/);
  left.cancelTransfer(self); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(budget.used, 0);
  await right.acceptBatch(self); assert.equal(budget.used, 40 * 1024 * 1024);
  right.cancelTransfer(bob); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(budget.used, 0);
});

test('the selected uplink limit is shared across active group destinations', () => {
  const {client, peers} = groupFixture(); const caps = new Map<string, number>();
  Reflect.set(client, 'state', {...client.getSnapshot(), settings: {...client.getSnapshot().settings, bandwidthLimitMbps: 20}});
  for (const [peerId, peer] of peers) {
    peer.client.getSnapshot = () => ({...defaultShareState(), stage: 'connected', transfers: [{direction: 'outgoing', status: 'transferring'}]});
    peer.client.syncSettings = (settings: {bandwidthLimitMbps: number}) => {caps.set(peerId, settings.bandwidthLimitMbps);};
  }
  (Reflect.get(client, 'syncChildSettings') as () => void).call(client);
  // Connections use one sender scheduler, rather than independent divided caps.
  assert.equal(caps.get(alice), 20); assert.equal(caps.get(bob), 20);
  assert.equal((Reflect.get(client, 'scheduler') as {getSnapshot(): {userLimitBytesPerSecond: number}}).getSnapshot().userLimitBytesPerSecond, 20 * 125000);
});

test('pending and approved roster hints are both delivered instead of dropping the second update', async () => {
  const events: string[] = [];
  const pair = new ShareClient({isolated: true, onGroupEvent: event => {events.push(event);}});
  const handle = Reflect.get(pair, 'handleControl') as (raw: string) => Promise<void>;
  await handle.call(pair, JSON.stringify({type: 'group-event', version: 1, event: 'roster-refresh'}));
  await handle.call(pair, JSON.stringify({type: 'group-event', version: 1, event: 'roster-refresh'}));
  assert.equal(events.length, 2);
});

test('a roster hint during an older in-flight poll schedules a trailing authoritative read', async () => {
  const {client} = groupFixture(); const delays: (number | undefined)[] = [];
  const credential: SavedGroup = {version: 1, groupId: self, code: '123abc', memberId: self, role: 'host', token: 'a'.repeat(64), secret: createInvitationSecret(), sessionName: 'Group', expiresAt: Date.now() + 60_000, pendingTransfers: false};
  Reflect.set(client, 'credential', credential);
  Reflect.set(client, 'schedule', (delay?: number) => {delays.push(delay);});
  const response = (approved: boolean) => ({...credential, status: 'open', memberStatus: 'approved', members: members.map(member => member.id === bob ? {...member, status: approved ? 'approved' : 'pending'} : member), links: [alice, bob].map(peerId => ({peerId, sessionId: peerId})), maxMembers: 8});
  let complete!: (result: unknown) => void;
  Reflect.set(client, 'api', () => new Promise(resolve => {complete = resolve;}));
  const poll = Reflect.get(client, 'poll') as () => Promise<void>;
  const refresh = Reflect.get(client, 'requestRosterRefresh') as () => void;
  const pending = poll.call(client);
  // Approval arrives while this request still contains the previous pending roster.
  refresh.call(client); refresh.call(client);
  complete(response(false)); await pending;
  const trailing = delays.at(-1);
  assert.equal(typeof trailing, 'number'); assert.ok(trailing! >= 0 && trailing! <= 2000);
  assert.equal(Reflect.get(client, 'refreshRequested'), false);
  assert.equal(client.getSnapshot().members.find(member => member.id === bob)?.status, 'pending');
  Reflect.set(client, 'api', async () => response(true));
  await poll.call(client);
  assert.equal(client.getSnapshot().members.find(member => member.id === bob)?.status, 'approved');
});

test('host end waits for server confirmation and retains the group on an error for retry', async () => {
  const {client, peers} = groupFixture(); const originalFetch = globalThis.fetch;
  const credential: SavedGroup = {version: 1, groupId: self, code: '123abc', memberId: self, role: 'host', token: 'a'.repeat(64), secret: createInvitationSecret(), sessionName: 'My group', expiresAt: Date.now() + 60_000, pendingTransfers: false};
  Reflect.set(client, 'credential', credential); let disconnected = 0;
  client.disconnect = async () => {disconnected++;};
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({error: 'Try again.'}), {status: 503});
    await client.endSession(); assert.equal(disconnected, 0); assert.equal(peers.size, 2);
    assert.match(client.getSnapshot().errors[0].message, /could not be ended/);
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true}));
    await client.endSession(); assert.equal(disconnected, 1);
  } finally {globalThis.fetch = originalFetch;}
});

test('expired group signaling keeps healthy local peers and stops polling', async () => {
  const {client, peers} = groupFixture(); const originalFetch = globalThis.fetch;
  Reflect.set(client, 'credential', {version: 1, groupId: self, code: '123abc', memberId: self, role: 'host', token: 'a'.repeat(64), secret: createInvitationSecret(), sessionName: 'My group', expiresAt: Date.now() + 60_000, pendingTransfers: false});
  let calls = 0;
  try {
    globalThis.fetch = async () => {calls++; return new Response(JSON.stringify({error: 'Expired.'}), {status: 410});};
    const poll = Reflect.get(client, 'poll') as () => Promise<void>;
    await poll.call(client); await poll.call(client);
    assert.equal(client.getSnapshot().stage, 'connected'); assert.equal(peers.size, 2); assert.equal(calls, 1);
    assert.match(client.getSnapshot().errors[0].message, /Existing connections and local transfers continue/);
    assert.equal(Reflect.get(client, 'timer'), null);
  } finally {globalThis.fetch = originalFetch;}
});

test('completed downloads stay accessible after a group member leaves', () => {
  const {client, peers} = groupFixture(); let downloaded = '';
  const peer = peers.get(alice);
  peers.delete(alice); (Reflect.get(client, 'archivedPeers') as Map<string, unknown>).set(alice, peer);
  peer.client.getSnapshot = () => ({...defaultShareState(), transfers: [{id: self, batchId: bob, name: 'ready.txt', size: 5, type: 'text/plain', direction: 'incoming', status: 'ready', bytes: 5, speed: 0, averageSpeed: 0, remainingSeconds: 0}]});
  peer.client.downloadFile = (id: string) => {downloaded = id;};
  (Reflect.get(client, 'aggregate') as () => void).call(client);
  const row = client.getSnapshot().transfers.find(file => file.name === 'ready.txt')!;
  assert.equal(row.peerName, 'Alice'); client.downloadFile(row.id); assert.equal(downloaded, self);
});

test('new addresses stay compact and saved historical rooms keep the supported route', () => {
  assert.equal(sessionPath('3b8e75'), '/3b8e75');
  assert.equal(sessionPath('my-sharing-session-3b8e75'), '/s/my-sharing-session-3b8e75');
  assert.equal(sessionPath(self), `/s/${self}`);
  assert.equal(validChat({id: self, text: 'bad time', sentAt: Number.MAX_SAFE_INTEGER, recipient: 'all'}), false);
});
