import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvitationSecret, parseInvitation } from '../lib/client/crypto';
import { sessionSlug, validateSessionIdentifier } from '../lib/server/policy';

test('six-character session addresses retain private invitation proof and distinguish groups', () => {
  const secret = createInvitationSecret();
  assert.deepEqual(parseInvitation(`https://share.test/3b8e75#key=${secret}`, 'https://share.test'), {sessionId: '3b8e75', secret});
  assert.deepEqual(parseInvitation(`https://share.test/3b8e75#key=${secret}&group=1`, 'https://share.test'), {sessionId: '3b8e75', secret, group: true});
  assert.throws(() => parseInvitation('https://share.test/3b8e75', 'https://share.test'), /incomplete/);
  assert.throws(() => parseInvitation(`https://other.test/3b8e75#key=${secret}`, 'https://share.test'), /different website/);
  assert.match(sessionSlug('A long display name'), /^[a-f0-9]{6}$/);
  assert.doesNotThrow(() => validateSessionIdentifier('3b8e75'));
  assert.doesNotThrow(() => validateSessionIdentifier('my-sharing-session-3b8e75'));
});
