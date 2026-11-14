import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deriveSignalKey, SignalDecryptor, fromBase64Url} from '../lib/client/crypto';
import {encodeFrame, decodeFrame} from '../lib/client/framing';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/browser-fixture.json', import.meta.url), 'utf8'));

test('shared Swift, Dart and website fixture decrypts with the production browser signaling code', async () => {
  const key = await deriveSignalKey(fixture.secret, fixture.room);
  const decryptor = new SignalDecryptor(key, fixture.room, 'guest');
  assert.deepEqual(await decryptor.decrypt(fixture.envelope), fixture.message);
  await assert.rejects(() => decryptor.decrypt(fixture.envelope), /Repeated/);
});

test('shared native framing fixture uses the exact browser uint64 offset and UUID encoding', () => {
  const payload = fromBase64Url(fixture.payload);
  const bytes = encodeFrame(fixture.batch, fixture.file, fixture.offset, payload.buffer as ArrayBuffer);
  assert.equal(Buffer.from(bytes).toString('hex'), '4638533100112233445546778899aabbccddeeffffeeddccbbaa498887765544332211000000000100000001000000050000000100017f80ff');
  const parsed = decodeFrame(bytes);
  assert.equal(parsed.offset, fixture.offset);
  assert.equal(parsed.batchId, fixture.batch);
  assert.equal(parsed.fileId, fixture.file);
});
