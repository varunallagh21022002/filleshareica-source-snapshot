import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeBase64Url, keyThumbprint, peerChallengeText, verifyAccessProof, verifyPeerAccess, type AccessRuntime} from '../lib/market/proofs';
import type {AccessClaims, AccessState, DeviceIdentity, MarketConfig} from '../lib/market/types';
import {SenderScheduler} from '../lib/client/send-scheduler';
import {ShareClient} from '../lib/client/controller';
import {GroupShareClient} from '../lib/client/group-controller';
import {StreamingHasher} from '../lib/client/hasher';
import {encodeFrame} from '../lib/client/framing';
import {digestSendManifest, type SendIntent, type SendPermit, type SendRuntime} from '../lib/market/send-types';
import {sendEnvelopeText, validateSendPermit, verifySendEnvelope} from '../lib/market/send-proofs';
import {SendOperation} from '../lib/client/send-operation';

const encoder = new TextEncoder();
const room = '01234567-89ab-4cde-8f01-23456789abcd';
async function identityFixture() {
  const issuer = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const installation = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
  const device: DeviceIdentity = {installationId: crypto.randomUUID(), deviceClass: 'desktop', label: 'Test desktop', publicKey: await crypto.subtle.exportKey('jwk', installation.publicKey)};
  const config = {issuer: 'fileshareica', publicKey: await crypto.subtle.exportKey('jwk', issuer.publicKey)} as MarketConfig;
  const sign = async (key: CryptoKey, text: string) => encodeBase64Url(new Uint8Array(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, encoder.encode(text))));
  const time = Date.now(); const now = Math.floor(time / 1000);
  const claims: AccessClaims = {iss: config.issuer, v: 1, installationId: device.installationId, keyThumbprint: await keyThumbprint(device.publicKey), kind: 'ad', hyperSpeed: false, iat: now, exp: now + 3600, paidUntil: null};
  const issue = async (patch: Partial<AccessClaims> = {}) => {
    const text = [encodeBase64Url(encoder.encode(JSON.stringify({alg: 'ES256', typ: 'JWT'}))), encodeBase64Url(encoder.encode(JSON.stringify({...claims, ...patch})))].join('.');
    return `${text}.${await sign(issuer.privateKey, text)}`;
  };
  const issueSend = async (intent: SendIntent, patch: Partial<SendPermit> = {}) => {
    const permit: SendPermit = {policyVersion: 2, operationId: intent.operationId, sessionId: intent.sessionId, manifestDigest: intent.manifestDigest, recipientIds: [...intent.recipientIds], senderInstallationId: device.installationId, decision: 'ad_completed', issuedAt: time, expiresAt: time + 600_000, proof: null, ...patch};
    const {proof: _proof, ...outer} = permit; void _proof;
    const text = [encodeBase64Url(encoder.encode(JSON.stringify({alg: 'ES256', typ: 'JWT'}))), encodeBase64Url(encoder.encode(JSON.stringify({iss: config.issuer, v: 2, purpose: 'send', ...outer, senderKeyThumbprint: claims.keyThumbprint, iat: Math.floor(permit.issuedAt / 1000), exp: Math.floor(permit.expiresAt / 1000)})))].join('.');
    return {...permit, proof: `${text}.${await sign(issuer.privateKey, text)}`};
  };
  return {device, config, claims, time, issue, issueSend, signDevice: (text: string) => sign(installation.privateKey, text)};
}

async function sendFixture(authorize?: SendRuntime['authorize']) {
  const identity = await identityFixture(); const sent: Record<string, unknown>[] = []; const milestones: string[] = []; const intents: SendIntent[] = [];
  const runtime: SendRuntime = {authorize: async intent => {intents.push(intent); return authorize ? authorize(intent) : identity.issueSend(intent);}, milestone: async event => {milestones.push(`${event.intent.operationId}:${event.status}`);}};
  const access: AccessRuntime = {getAccess: () => ({kind: 'none', allowed: false, hyperSpeed: false, proof: null, expiresAt: null, serverNow: identity.time, config: identity.config} as AccessState), getIdentity: async () => identity.device, signChallenge: identity.signDevice, subscribe: () => () => {}};
  const client = new ShareClient({isolated: true, accessRuntime: access, sendRuntime: runtime});
  Reflect.set(client, 'state', {...client.getSnapshot(), stage: 'connected', sessionId: room, role: 'host'});
  Reflect.set(client, 'peerSendPolicy', 2); Reflect.set(client, 'control', {readyState: 'open', send: (raw: string) => sent.push(JSON.parse(raw))});
  return {client, identity, sent, milestones, intents, runtime, access};
}

async function realGroupFixture() {
  const fixture = await sendFixture(); const group = new GroupShareClient({accessRuntime: fixture.access, sendRuntime: fixture.runtime});
  const self = crypto.randomUUID(); const alice = crypto.randomUUID(); const bob = crypto.randomUUID();
  const members = [{id: self, name: 'Host', role: 'host', status: 'approved'}, {id: alice, name: 'Alice', role: 'guest', status: 'approved'}, {id: bob, name: 'Bob', role: 'guest', status: 'approved'}];
  Reflect.set(group, 'state', {...group.getSnapshot(), groupMode: true, stage: 'connected', sessionId: room, selfId: self, members});
  const children = new Map<string, {client: ShareClient; sent: Record<string, unknown>[]}>([alice, bob].map(peerId => {
    const client = new ShareClient({isolated: true, accessRuntime: fixture.access, sendRuntime: fixture.runtime, sendScope: {sessionId: room, selfRecipientId: self, peerRecipientId: peerId}});
    Reflect.set(client, 'state', {...client.getSnapshot(), stage: 'connected', sessionId: crypto.randomUUID(), role: 'host'}); Reflect.set(client, 'peerSendPolicy', 2);
    const sent: Record<string, unknown>[] = []; Reflect.set(client, 'control', {readyState: 'open', send: (raw: string) => sent.push(JSON.parse(raw))});
    return [peerId, {client, sent}];
  }));
  Reflect.set(group, 'peers', new Map([...children].map(([peerId, child]) => [peerId, {client: child.client, sessionId: child.client.getSnapshot().sessionId, unsubscribe: () => {}}])));
  return {...fixture, group, children, alice, bob};
}
function markPayloadSent(client: ShareClient, fileId: string) {
  const item = (Reflect.get(client, 'outgoing') as Map<string, {ending: boolean; offset: number; status: string; file: File; digest: string}>).get(fileId)!;
  item.ending = true; item.offset = item.file.size; item.status = 'verifying';
  item.digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
}

test('real group children share one operation; partial-success retry keeps authorization without another count', async () => {
  const fixture = await realGroupFixture(); fixture.group.addFiles([new File(['abc'], 'group.txt')]); await fixture.group.sendSelected('all');
  assert.equal(fixture.intents.length, 1); const operationId = fixture.intents[0].operationId;
  const alice = fixture.children.get(fixture.alice)!; const bob = fixture.children.get(fixture.bob)!;
  const aliceOffer = alice.sent[0]; const bobOffer = bob.sent[0];
  assert.equal((aliceOffer.authorization as {intent: SendIntent}).intent.operationId, operationId);
  assert.equal((bobOffer.authorization as {intent: SendIntent}).intent.operationId, operationId);
  const fileId = (aliceOffer.files as {id: string}[])[0].id; assert.equal((bobOffer.files as {id: string}[])[0].id, fileId);
  const aliceControl = Reflect.get(alice.client, 'handleControl') as (raw: string) => Promise<void>;
  const bobControl = Reflect.get(bob.client, 'handleControl') as (raw: string) => Promise<void>;
  markPayloadSent(alice.client, fileId);
  await aliceControl.call(alice.client, JSON.stringify({type: 'complete', id: fileId, operationId, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', saved: true}));
  await bobControl.call(bob.client, JSON.stringify({type: 'reject', batchId: bobOffer.batchId, operationId}));
  assert.deepEqual(fixture.milestones, [`${operationId}:verified`]);
  await fixture.group.retryTransfer(`${fixture.bob}:${fileId}`);
  assert.equal(fixture.intents.length, 2); assert.equal(fixture.intents[1], fixture.intents[0]);
  assert.equal((bob.sent[1].authorization as {intent: SendIntent}).intent.operationId, operationId);
  assert.equal((bob.sent[1].files as {id: string}[])[0].id, fileId);
  markPayloadSent(bob.client, fileId);
  await bobControl.call(bob.client, JSON.stringify({type: 'complete', id: fileId, operationId, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', saved: true}));
  assert.deepEqual(fixture.milestones, [`${operationId}:verified`]); assert.equal(fixture.group.getSnapshot().sendPreparing, false);
});

test('a real group releases only after every child rejects before success', async () => {
  const fixture = await realGroupFixture(); fixture.group.addFiles([new File(['abc'], 'rejected.txt')]); await fixture.group.sendSelected('all');
  const operationId = fixture.intents[0].operationId;
  for (const [index, child] of [...fixture.children.values()].entries()) {
    const offer = child.sent[0];
    await (Reflect.get(child.client, 'handleControl') as (raw: string) => Promise<void>).call(child.client, JSON.stringify({type: 'reject', batchId: offer.batchId, operationId}));
    assert.equal(fixture.milestones.length, index);
  }
  assert.deepEqual(fixture.milestones, [`${operationId}:released`]);
  const child = fixture.children.get(fixture.bob)!;
  const fileId = (child.sent[0].files as {id: string}[])[0].id;
  await fixture.group.retryTransfer(`${fixture.bob}:${fileId}`);
  const retry = child.sent[1];
  await (Reflect.get(child.client, 'handleControl') as (raw: string) => Promise<void>).call(child.client, JSON.stringify({type:'reject',batchId:retry.batchId,operationId}));
  assert.deepEqual(fixture.milestones, [`${operationId}:released`,`${operationId}:released`]);
  assert.equal(fixture.intents[1], fixture.intents[0]);
});

test('Send waits for one authorization and keeps its immutable snapshot across concurrent input changes', async () => {
  let resolve!: (permit: SendPermit | null) => void;
  const fixture = await sendFixture(() => new Promise(done => {resolve = done;}));
  fixture.client.addFiles([new File(['one'], 'original.txt')]);
  const sending = fixture.client.sendSelected();
  while (!fixture.intents.length) await new Promise(done => setTimeout(done, 0));
  assert.equal(fixture.client.getSnapshot().sendPreparing, true); assert.equal(fixture.sent.length, 0);
  await fixture.client.sendSelected(); assert.equal(fixture.intents.length, 1);
  fixture.client.addFiles([new File(['two'], 'later.txt')]);
  assert.equal(fixture.intents[0].files.length, 1); assert.ok(Object.isFrozen(fixture.intents[0].files));
  resolve(await fixture.identity.issueSend(fixture.intents[0])); await sending;
  assert.equal(fixture.sent.length, 1); assert.equal(fixture.sent[0].type, 'offer'); assert.equal(fixture.sent[0].version, 2);
  assert.equal((fixture.sent[0].files as {name: string}[])[0].name, 'original.txt');
  assert.deepEqual(fixture.client.getSnapshot().selectedFiles.map(file => file.name), ['later.txt']);
  assert.equal(fixture.client.getSnapshot().sendPreparing, false);
});

test('cancelled authorization sends no offer and preserves selected files', async () => {
  const fixture = await sendFixture(async () => null); fixture.client.addFiles([new File(['one'], 'original.txt')]);
  await fixture.client.sendSelected(); assert.equal(fixture.sent.length, 0); assert.equal(fixture.milestones.length, 0); assert.equal(fixture.client.getSnapshot().selectedFiles.length, 1);
});

test('a permit arriving after disconnect is released without reviving the old connection', async () => {
  let resolve!: (permit: SendPermit | null) => void; const fixture = await sendFixture(() => new Promise(done => {resolve = done;}));
  fixture.client.addFiles([new File(['one'], 'original.txt')]); const sending = fixture.client.sendSelected();
  while (!fixture.intents.length) await new Promise(done => setTimeout(done, 0));
  await fixture.client.disconnect(); resolve(await fixture.identity.issueSend(fixture.intents[0])); await sending;
  assert.equal(fixture.client.getSnapshot().stage, 'idle'); assert.equal(fixture.client.getSnapshot().sendPreparing, false); assert.equal(fixture.sent.length, 0);
  assert.deepEqual(fixture.milestones, [`${fixture.intents[0].operationId}:released`]);
});

test('verified send envelopes bind the online issuer, device key, manifest, room and recipient', async () => {
  const fixture = await identityFixture();
  const intent: SendIntent = {operationId: crypto.randomUUID(), sessionId: room, files: [{id: crypto.randomUUID(), size: 3}], recipientIds: [`${room}:guest`], manifestDigest: ''}; intent.manifestDigest = await digestSendManifest(intent);
  const permit = await fixture.issueSend(intent);
  const envelope = {intent, permit, device: fixture.device, signature: await fixture.signDevice(sendEnvelopeText(room, 0, intent.recipientIds[0], intent, permit))};
  const expected = {roomId: room, revision: 0, sessionId: room, recipientId: intent.recipientIds[0], files: intent.files, nowMs: fixture.time};
  await verifySendEnvelope(envelope, expected, fixture.config);
  await assert.rejects(verifySendEnvelope(envelope, {...expected, recipientId: 'another-person'}, fixture.config), /recipient/);
  await assert.rejects(verifySendEnvelope(envelope, {...expected, revision: 1}, fixture.config), /verified/);
  await assert.rejects(verifySendEnvelope(envelope, {...expected, files: [{...intent.files[0], size: 4}]}, fixture.config), /files/);
  await assert.rejects(validateSendPermit(intent, {...permit, decision: 'premium'}, fixture.config, fixture.time, fixture.device), /changed/);
  const other = await identityFixture();
  await assert.rejects(validateSendPermit(intent, permit, fixture.config, fixture.time, {...fixture.device, publicKey: other.device.publicKey}), /installation key/);
  await assert.rejects(validateSendPermit(intent, permit, fixture.config, fixture.time + 601_000, fixture.device), /authorization/);
});

test('receiving, accepting and chat are free; only the sender emits verified accounting once', async () => {
  const fixture = await sendFixture(); fixture.client.addFiles([new File(['abc'], 'received.txt')]); await fixture.client.sendSelected();
  const offer = fixture.sent[0]; const receiverControls: Record<string, unknown>[] = []; let receiverAuthorization = 0;
  const receiver = new ShareClient({isolated: true, accessRuntime: fixture.access, sendRuntime: {authorize: async () => {receiverAuthorization++; return null;}, milestone: async () => {throw new Error('Receiver must not account sender usage.');}}});
  Reflect.set(receiver, 'state', {...receiver.getSnapshot(), stage: 'connected', sessionId: room, role: 'guest'});
  Reflect.set(receiver, 'control', {readyState: 'open', send: (raw: string) => receiverControls.push(JSON.parse(raw))});
  const receiveControl = Reflect.get(receiver, 'handleControl') as (raw: string) => Promise<void>;
  const sendControl = Reflect.get(fixture.client, 'handleControl') as (raw: string) => Promise<void>;
  await receiveControl.call(receiver, JSON.stringify(offer)); assert.equal(receiver.getSnapshot().incomingBatches.length, 1);
  await receiver.acceptBatch(offer.batchId as string); assert.equal(receiverAuthorization, 0);
  await sendControl.call(fixture.client, JSON.stringify(receiverControls[0]));
  const hasher = new StreamingHasher(); Reflect.set(receiver, 'hasher', hasher);
  const file = (offer.files as {id: string}[])[0]; const operationId = fixture.intents[0].operationId;
  await (Reflect.get(receiver, 'receiveFrame') as (raw: ArrayBuffer) => Promise<void>).call(receiver, encodeFrame(offer.batchId as string, file.id, 0, encoder.encode('abc').buffer));
  await receiveControl.call(receiver, JSON.stringify({type: 'finish', id: file.id, operationId, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}));
  const complete = receiverControls.find(message => message.type === 'complete')!;
  markPayloadSent(fixture.client, file.id);
  await sendControl.call(fixture.client, JSON.stringify(complete)); await sendControl.call(fixture.client, JSON.stringify(complete));
  assert.deepEqual(fixture.milestones, [`${operationId}:verified`]); assert.equal(receiver.getSnapshot().transfers[0].status, 'ready');
  const chat = {type: 'chat', version: 1, id: crypto.randomUUID(), text: 'Free chat', sentAt: Date.now(), recipient: 'all'};
  await receiveControl.call(receiver, JSON.stringify(chat)); assert.equal(receiver.getSnapshot().chatMessages.length, 1); assert.equal(receiverAuthorization, 0); hasher.destroy();
});

test('all rejected files release once; retry keeps the original operation and does not create a new intent', async () => {
  const fixture = await sendFixture(); fixture.client.addFiles([new File(['abc'], 'retry.txt')]); await fixture.client.sendSelected();
  const first = fixture.sent[0]; const operationId = fixture.intents[0].operationId;
  const handle = Reflect.get(fixture.client, 'handleControl') as (raw: string) => Promise<void>;
  await handle.call(fixture.client, JSON.stringify({type: 'reject', batchId: first.batchId, operationId}));
  assert.deepEqual(fixture.milestones, [`${operationId}:released`]);
  const fileId = (first.files as {id: string}[])[0].id; await fixture.client.retryTransfer(fileId);
  assert.equal(fixture.intents.length, 2); assert.equal(fixture.intents[1], fixture.intents[0]);
  assert.equal((fixture.sent[1].files as {id: string}[])[0].id, fileId);
  markPayloadSent(fixture.client, fileId);
  await handle.call(fixture.client, JSON.stringify({type: 'complete', id: fileId, operationId, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', saved: true}));
  assert.deepEqual(fixture.milestones, [`${operationId}:released`, `${operationId}:verified`]);
});

test('an early completion message cannot count an offered or unsent file as verified', async () => {
  const fixture = await sendFixture(); fixture.client.addFiles([new File(['abc'], 'not-sent.txt')]); await fixture.client.sendSelected();
  const fileId = (fixture.sent[0].files as {id: string}[])[0].id;
  await (Reflect.get(fixture.client, 'handleControl') as (raw: string) => Promise<void>).call(fixture.client, JSON.stringify({type: 'complete', id: fileId, operationId: fixture.intents[0].operationId, saved: true}));
  assert.equal(fixture.milestones.length, 0); assert.equal(fixture.client.getSnapshot().transfers[0].status, 'offered');
});

test('one group operation settles on first verified recipient and never releases after partial success', async () => {
  const events: string[] = []; const intent = {operationId: crypto.randomUUID()} as SendIntent;
  const operation = new SendOperation(intent, null, {authorize: async () => null, milestone: async event => {events.push(event.status);}});
  operation.expect('alice:file'); operation.expect('bob:file'); operation.seal();
  operation.outcome('alice:file', 'verified'); operation.outcome('bob:file', 'released');
  operation.open(); operation.expect('bob:file'); operation.seal(); operation.outcome('bob:file', 'verified');
  assert.deepEqual(events, ['verified']);
});

test('legacy peers are explicitly blocked only for new offers, while free chat remains available', async () => {
  const fixture = await sendFixture(); Reflect.set(fixture.client, 'peerSendPolicy', 1);
  fixture.client.addFiles([new File(['abc'], 'pending.txt')]); await fixture.client.sendSelected();
  assert.equal(fixture.intents.length, 0); assert.equal(fixture.sent.length, 0); assert.match(fixture.client.getSnapshot().errors[0].message, /Refresh both devices/);
  assert.equal(fixture.client.sendChatMessage({id: crypto.randomUUID(), text: 'Still available', sentAt: Date.now(), recipient: 'all'}), true);
  assert.equal(fixture.sent[0].type, 'chat');
});

test('peer entitlement verifies issuer, expiry, installation key and per-connection challenge', async () => {
  const fixture = await identityFixture(); const proof = await fixture.issue(); const challenge = crypto.randomUUID();
  const value = {proof, device: fixture.device, challenge, signature: await fixture.signDevice(peerChallengeText(room, 2, challenge, proof))};
  const context = {sessionId: room, revision: 2, challenge, nowMs: fixture.time};
  assert.equal((await verifyPeerAccess(value, fixture.config, context)).kind, 'ad');
  await assert.rejects(verifyPeerAccess(value, fixture.config, {...context, challenge: crypto.randomUUID()}), /match/);
  await assert.rejects(verifyPeerAccess(value, fixture.config, {...context, sessionId: 'other-room'}), /ownership/);
  await assert.rejects(verifyPeerAccess(value, fixture.config, {...context, revision: 3}), /ownership/);
  await assert.rejects(verifyPeerAccess({...value, device: {...value.device, installationId: 'copied-proof'}}, fixture.config, context), /another installation/);
  await assert.rejects(verifyAccessProof(proof, {...fixture.config, issuer: 'untrusted'}, fixture.time));
  await assert.rejects(verifyAccessProof(proof, fixture.config, fixture.time + 3_601_000), /expired/);
  await assert.rejects(verifyAccessProof(await fixture.issue({kind: 'ad', hyperSpeed: true}), fixture.config, fixture.time), /invalid claims/);
});

test('Standard endpoints never require an hourly pass; verified Premium affects speed only', async () => {
  const fixture = await identityFixture(); const proof = await fixture.issue();
  let access = {allowed: true, kind: 'ad', hyperSpeed: false, proof, expiresAt: fixture.claims.exp * 1000, serverNow: fixture.time, config: fixture.config} as AccessState;
  const runtime: AccessRuntime = {getAccess: () => access, getIdentity: async () => fixture.device, signChallenge: fixture.signDevice, subscribe: () => () => {}};
  const client = new ShareClient({accessRuntime: runtime});
  assert.equal(client.getAccessBlockReason(), null);
  Reflect.set(client, 'peerClaims', {...fixture.claims, kind: 'paid', hyperSpeed: true, paidUntil: fixture.time + 100_000_000});
  assert.equal(client.getAccessBlockReason(), null);
  assert.equal((Reflect.get(client, 'pairHyperSpeed') as () => boolean).call(client), true);
  access = {...access, allowed: false, kind: 'none', proof: null};
  assert.equal(client.getAccessBlockReason(), null);
  assert.equal((Reflect.get(client, 'pairHyperSpeed') as () => boolean).call(client), true);
});

test('nonce proofs are consumed once; replay cannot replace a newer peer entitlement', async () => {
  const fixture = await identityFixture(); const proof = await fixture.issue({kind: 'paid', hyperSpeed: true, paidUntil: fixture.time + 100_000_000}); const challenge = crypto.randomUUID();
  const runtime: AccessRuntime = {getAccess: () => ({allowed: true, kind: 'ad', hyperSpeed: false, proof, expiresAt: fixture.claims.exp * 1000, serverNow: fixture.time, config: fixture.config} as AccessState), getIdentity: async () => fixture.device, signChallenge: fixture.signDevice, subscribe: () => () => {}};
  const client = new ShareClient({isolated: true, accessRuntime: runtime});
  Reflect.set(client, 'state', {...client.getSnapshot(), sessionId: room}); Reflect.set(client, 'accessChallenge', challenge);
  const message = {type: 'access-proof', version: 1, proof, challenge, device: fixture.device, signature: await fixture.signDevice(peerChallengeText(room, 0, challenge, proof))};
  const handle = Reflect.get(client, 'handleControl') as (raw: string) => Promise<void>;
  await handle.call(client, JSON.stringify(message));
  const first = Reflect.get(client, 'peerClaims'); assert.equal(first.kind, 'paid');
  await handle.call(client, JSON.stringify({...message, proof: 'forged'}));
  assert.equal(Reflect.get(client, 'peerClaims'), first);
});

test('expired hourly access never blocks receiving; an accepted file still verifies and remains saveable', async () => {
  const fixture = await identityFixture(); const proof = await fixture.issue(); let time = fixture.time;
  const runtime: AccessRuntime = {getAccess: () => ({allowed: true, kind: 'ad', hyperSpeed: false, proof, expiresAt: fixture.claims.exp * 1000, serverNow: fixture.time, config: fixture.config} as AccessState), now: () => time, getIdentity: async () => fixture.device, signChallenge: fixture.signDevice, subscribe: () => () => {}};
  const client = new ShareClient({isolated: true, accessRuntime: runtime}); const fileId = crypto.randomUUID(); const batchId = crypto.randomUUID(); const controls: {type: string}[] = [];
  Reflect.set(client, 'state', {...client.getSnapshot(), stage: 'connected', sessionId: room, incomingBatches: [{id: batchId, files: [{id: fileId, name: 'accepted.txt', size: 3, type: 'text/plain'}], peerName: 'Sender', receivedAt: time}]});
  Reflect.set(client, 'control', {readyState: 'open', send: (raw: string) => controls.push(JSON.parse(raw))});
  Reflect.set(client, 'peerClaims', fixture.claims); const hasher = new StreamingHasher(); Reflect.set(client, 'hasher', hasher);
  await client.acceptBatch(batchId); assert.equal(client.getSnapshot().transfers[0].status, 'queued');
  time = fixture.claims.exp * 1000 + 1;
  const handle = Reflect.get(client, 'handleControl') as (raw: string) => Promise<void>;
  await handle.call(client, JSON.stringify({type: 'offer', version: 1, batchId: crypto.randomUUID(), files: [{id: crypto.randomUUID(), name: 'late.txt', size: 3, type: 'text/plain'}]}));
  assert.equal(controls.some(control => control.type === 'access-denied'), false); assert.equal(client.getSnapshot().incomingBatches.length, 1);
  const receive = Reflect.get(client, 'receiveFrame') as (raw: ArrayBuffer) => Promise<void>;
  await receive.call(client, encodeFrame(batchId, fileId, 0, encoder.encode('abc').buffer));
  await handle.call(client, JSON.stringify({type: 'finish', id: fileId, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}));
  assert.equal(client.getSnapshot().transfers[0].status, 'ready');
  assert.equal(await (Reflect.get(client, 'downloads') as Map<string, Blob>).get(fileId)?.text(), 'abc');
  hasher.destroy();
});

test('group Send to everyone reports a legacy recipient before offering any files', async () => {
  const group = new GroupShareClient(); const first = crypto.randomUUID(); const second = crypto.randomUUID(); let offered = 0;
  Reflect.set(group, 'state', {...group.getSnapshot(), groupMode: true, selfId: 'host', members: [{id: first, name: 'Ready phone', status: 'approved'}, {id: second, name: 'Needs refresh', status: 'approved'}]});
  Reflect.set(group, 'peers', new Map([first, second].map((key, index) => [key, {client: {getSnapshot: () => ({...new ShareClient().getSnapshot(), stage: 'connected'}), getAccessBlockReason: () => index ? 'Refresh both devices for the current send policy.' : null, addFiles: () => {offered++;}, sendSelected: async () => {}}, unsubscribe: () => {}, sessionId: key}])));
  group.addFiles([new File(['safe'], 'test.txt')]); await group.sendSelected('all');
  assert.equal(offered, 0); assert.equal(group.getSnapshot().selectedFiles.length, 1);
  assert.match(group.getSnapshot().errors[0].message, /Needs refresh/);
});

test('calibration uses acknowledged real payload, excludes pauses and freezes until retest', async () => {
  let time = 0; const scheduler = new SenderScheduler(() => time);
  scheduler.setActive('a', true); scheduler.sent(100_000); time = 1000; scheduler.ack('a', 100_000);
  scheduler.setActive('a', false); time = 101_000; scheduler.setActive('a', true);
  scheduler.sent(200_000); time += 2000; scheduler.ack('a', 300_000);
  const policy = scheduler.getSnapshot();
  assert.equal(policy.calibration, 'complete');
  // The reference freezes at the measurement boundary rather than being
  // recalculated from subsequent tier-limited traffic.
  const reference = policy.referenceBytesPerSecond; assert.equal(reference, 100_000);
  assert.equal(policy.freeLimitBytesPerSecond, reference * .65);
  time += 10_000; scheduler.ack('a', 300_001);
  assert.equal(scheduler.getSnapshot().referenceBytesPerSecond, reference);
  scheduler.retest(); assert.equal(scheduler.getSnapshot().calibration, 'waiting');
  scheduler.sent(64); time += 1000; scheduler.ack('a', 300_065);
  assert.equal(scheduler.getSnapshot().calibration, 'measuring'); scheduler.destroy();
});

test('shared free pool aggregates recipients while paid pairs bypass only the tier bucket', async () => {
  let time = 0; const scheduler = new SenderScheduler(() => time);
  scheduler.setActive('a', true); scheduler.sent(100_000); time = 3000; scheduler.ack('a', 100_000);
  // First frame uses the one shared burst; the next free recipient must wait.
  assert.equal(await scheduler.acquire(65_536, () => true, () => true), true);
  let freeResolved = false; const free = scheduler.acquire(65_536, () => true, () => true).then(value => {freeResolved = value;});
  await Promise.resolve(); assert.equal(freeResolved, false);
  assert.equal(await scheduler.acquire(65_536, () => false, () => true), true);
  scheduler.setUserLimit(1); assert.equal(await scheduler.acquire(65_536, () => false, () => true), true);
  let paidResolved = false; const paid = scheduler.acquire(65_536, () => false, () => true).then(value => {paidResolved = value;});
  await Promise.resolve(); assert.equal(paidResolved, false);
  time += 10_000; scheduler.setUserLimit(1); await free;
  time += 10_000; scheduler.setUserLimit(1); await paid;
  assert.equal(freeResolved, true); assert.equal(paidResolved, true); scheduler.destroy();
});
