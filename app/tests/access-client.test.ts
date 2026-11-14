import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessStore, base64url, deviceAssertionMessage, identifyDevice, restorePaidLease } from '../lib/client/access-store';
import type { AccessClaims, AccessState, DeviceIdentity, MarketConfig } from '../lib/market/types';
import { keyThumbprint } from '../lib/market/proofs';
import { signClaims } from '../lib/server/market-crypto';

test('installation classification keeps mobile and desktop paid slots distinct', () => {
  assert.equal(identifyDevice('Mozilla Android 15 Mobile').deviceClass, 'mobile');
  assert.equal(identifyDevice('Mozilla iPad OS').deviceClass, 'mobile');
  assert.equal(identifyDevice('Mozilla Macintosh Intel Mac OS').deviceClass, 'desktop');
  assert.equal(identifyDevice('Windows NT').label, 'Windows browser');
});
test('device assertion canonical text binds installation, time and nonce', () => {
  assert.equal(deviceAssertionMessage('test-installation', 1234, 'random-nonce'), 'fileshare-device-v1:test-installation:1234:random-nonce');
  assert.notEqual(deviceAssertionMessage('other-installation', 1234, 'random-nonce'), deviceAssertionMessage('test-installation', 1234, 'random-nonce'));
  assert.equal(base64url(Uint8Array.from([255, 239, 191])), '_--_');
});
test('access store can be imported server-side without browser storage or unstable snapshots', () => {
  assert.equal(accessStore.getSnapshot(), accessStore.getSnapshot());
  assert.equal(accessStore.getSnapshot().access, null);
  assert.equal(accessStore.getSnapshot().loading, false);
});

async function paidFixture() {
  const now = 1_800_000_000_000;
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const installation = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const identity: DeviceIdentity = { installationId: crypto.randomUUID(), deviceClass: 'desktop', label: 'Test browser', publicKey: await crypto.subtle.exportKey('jwk', installation.publicKey) };
  const config: MarketConfig = { development: true, googleClientId: null, paymentMode: 'demo', adsMode: 'demo', publisherId: null, supportEmail: null, issuer: 'https://sharing.test', publicKey: await crypto.subtle.exportKey('jwk', signing.publicKey), plans: [] };
  const claims: AccessClaims = { iss: config.issuer, v: 1, installationId: identity.installationId, keyThumbprint: await keyThumbprint(identity.publicKey), kind: 'paid', hyperSpeed: true, iat: now / 1000, exp: (now + 60 * 60_000) / 1000, paidUntil: now + 30 * 24 * 60 * 60_000 };
  const proof = (await signClaims(claims, JSON.stringify(await crypto.subtle.exportKey('jwk', signing.privateKey))))!;
  const access: AccessState = { kind: 'paid', allowed: true, hyperSpeed: true, expiresAt: claims.exp * 1000, paidUntil: claims.paidUntil, serverNow: now, proof, deviceStatus: 'registered', account: null, devices: [], orders: [], config };
  return { now, identity, config, claims, access };
}
test('offline restoration derives expiry and benefits from signed claims, not writable cached fields', async () => {
  const fixture = await paidFixture();
  const manipulated = { ...fixture.access, allowed: false, hyperSpeed: false, expiresAt: fixture.now + 999_999_999_999, paidUntil: fixture.now + 999_999_999_999, config: { ...fixture.config, issuer: 'https://untrusted.test' } };
  const restored = await restorePaidLease(manipulated, fixture.identity, fixture.config, fixture.now);
  assert.equal(restored?.allowed, true); assert.equal(restored?.hyperSpeed, true);
  assert.equal(restored?.expiresAt, fixture.claims.exp * 1000); assert.equal(restored?.paidUntil, fixture.claims.paidUntil);
  assert.equal(restored?.config.issuer, fixture.config.issuer);
});
test('replacing both localStorage proof and its embedded public key cannot replace the pinned network issuer', async () => {
  const fixture = await paidFixture();
  const attacker = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const forged = { ...fixture.access, config: { ...fixture.config, publicKey: await crypto.subtle.exportKey('jwk', attacker.publicKey) }, proof: await signClaims(fixture.claims, JSON.stringify(await crypto.subtle.exportKey('jwk', attacker.privateKey))) };
  assert.equal(await restorePaidLease(forged, fixture.identity, fixture.config, fixture.now), null);
  assert.equal(await restorePaidLease(forged, fixture.identity, null, fixture.now), null);
});
test('offline paid leases cannot restore on a different installation or after signed expiry', async () => {
  const fixture = await paidFixture();
  assert.equal(await restorePaidLease(fixture.access, { ...fixture.identity, installationId: 'other-installation' }, fixture.config, fixture.now), null);
  assert.equal(await restorePaidLease(fixture.access, fixture.identity, fixture.config, fixture.claims.exp * 1000), null);
});
