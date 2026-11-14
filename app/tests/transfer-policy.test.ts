import assert from 'node:assert/strict';
import test from 'node:test';
import {MAX_BATCH_FILES, MAX_FILE_BYTES, isValidFileSize} from '../lib/transfer-policy';
import {digestSendManifest, type SendIntent, type SendPermit} from '../lib/market/send-types';
import {validateSendPermit} from '../lib/market/send-proofs';

async function offlineManifest(sizes: number[]) {
  const intent: SendIntent = {operationId: crypto.randomUUID(), sessionId: crypto.randomUUID(), files: sizes.map(size => ({id: crypto.randomUUID(), size})), recipientIds: ['recipient'], manifestDigest: ''};
  intent.manifestDigest = await digestSendManifest(intent);
  const permit: SendPermit = {policyVersion: 2, operationId: intent.operationId, sessionId: intent.sessionId, manifestDigest: intent.manifestDigest, recipientIds: intent.recipientIds, senderInstallationId: 'test-installation', decision: 'offline', issuedAt: 1_000, expiresAt: 601_000, proof: null};
  return {intent, permit};
}

test('100 GB policy uses decimal per-file bytes and exact safe integers', () => {
  assert.equal(MAX_FILE_BYTES, 100_000_000_000);
  assert.equal(MAX_BATCH_FILES, 500);
  for (const size of [0, 1, 2 ** 32 + 17, MAX_FILE_BYTES - 1, MAX_FILE_BYTES]) assert.equal(isValidFileSize(size), true, String(size));
  for (const size of [-1, 0.5, MAX_FILE_BYTES + 1, 100 * 1024 ** 3, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '100', null, undefined, BigInt(1)]) assert.equal(isValidFileSize(size), false, String(size));
});

test('peer authorizations enforce the same 100 GB per-file boundary, with no combined session cap', async () => {
  const allowed = await offlineManifest([0, 2 ** 32 + 17, MAX_FILE_BYTES, MAX_FILE_BYTES]);
  await validateSendPermit(allowed.intent, allowed.permit, null, 1_000);
  for (const size of [-1, 0.5, MAX_FILE_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
    const rejected = await offlineManifest([size]);
    await assert.rejects(validateSendPermit(rejected.intent, rejected.permit, null, 1_000), /file manifest/);
  }
});

test('peer authorizations allow 500 files and reject a 501-file batch', async () => {
  const allowed = await offlineManifest(Array(MAX_BATCH_FILES).fill(0));
  await validateSendPermit(allowed.intent, allowed.permit, null, 1_000);
  const rejected = await offlineManifest(Array(MAX_BATCH_FILES + 1).fill(0));
  await assert.rejects(validateSendPermit(rejected.intent, rejected.permit, null, 1_000), /authorization/);
});
