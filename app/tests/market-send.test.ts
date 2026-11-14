import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AccessState, DeviceAssertion, DeviceIdentity, PublicOrder } from "../lib/market/types";
import { digestSendManifest, offlineEventText, type OfflineSendEvent, type PreparedSend, type SendAccessSummary, type SendIntent } from "../lib/market/send-types";
import { MarketService, type MarketEnvironment } from "../lib/server/market";
import { base64url, thumbprint, unbase64url } from "../lib/server/market-crypto";
import { MAX_BATCH_FILES, MAX_FILE_BYTES } from "../lib/transfer-policy";

const NOW = Date.UTC(2026, 0, 31, 13, 14, 15, 123);
function database() {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const prepare = (sql: string) => {
    let values: (string | number | null)[] = [];
    const execute = () => { if (/\bRETURNING\b|^SELECT\b/i.test(sql)) return { results: sqlite.prepare(sql).all(...values), success: true }; sqlite.prepare(sql).run(...values); return { results: [], success: true }; };
    const statement = { bind(...args: (string | number | null)[]) { values = args; return statement; }, async first<T>() { return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null; }, async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[], success: true }; }, async run() { return execute(); }, execute }; return statement;
  };
  const db = { prepare, async batch(statements: ReturnType<typeof prepare>[]) { sqlite.exec("BEGIN"); try { const rows = statements.map(s => s.execute()); sqlite.exec("COMMIT"); return rows; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } } as unknown as D1Database;
  return { db, sqlite };
}
async function installation() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const identity: DeviceIdentity = { installationId: crypto.randomUUID(), deviceClass: "desktop", label: "Test browser", publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey) };
  const sign = async (text: string) => base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(text))));
  return { identity, async assertion(timestamp: number): Promise<DeviceAssertion> { const nonce = crypto.randomUUID(); return { device: identity, timestamp, nonce, signature: await sign(`fileshare-device-v1:${identity.installationId}:${timestamp}:${nonce}`) }; }, sign };
}
async function harness() {
  const { db, sqlite } = database(); const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const env: MarketEnvironment = { MARKET_DEV_MODE: "1", MARKET_SIGNING_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", signing.privateKey)) };
  const device = await installation(); let now = NOW; const cookies = new Map<string, string>();
  const api = async <T = AccessState>(path: string, body: Record<string, unknown> = {}, target = device, origin = "http://127.0.0.1:5173") => {
    const request = new Request(`${origin}/api/market/${path}`, { method: "POST", headers: { origin, "content-type": "application/json", cookie: cookies.get(target.identity.installationId) || "" }, body: JSON.stringify({ ...body, assertion: await target.assertion(now) }) });
    const response = await new MarketService(db, env, request, now).dispatch(path);
    const cookie = response.headers.get("set-cookie"); if (cookie) cookies.set(target.identity.installationId, cookie.split(";")[0]);
    return { status: response.status, data: await response.json() as T };
  };
  const intent = async (overrides: Partial<SendIntent> = {}): Promise<SendIntent> => {
    const sessionId = overrides.sessionId || crypto.randomUUID();
    const value = { operationId: crypto.randomUUID(), sessionId, files: [{ id: crypto.randomUUID(), size: 12345 }], recipientIds: [`${sessionId}:guest`], manifestDigest: "", ...overrides };
    value.manifestDigest = await digestSendManifest(value); return value;
  };
  const event = async (send: SendIntent, creditId?: string, verifiedAt = now, target = device): Promise<OfflineSendEvent> => {
    const value = { operationId: send.operationId, sessionId: send.sessionId, manifestDigest: send.manifestDigest, installationId: target.identity.installationId, verifiedAt, ...(creditId ? { creditId } : {}) };
    return { ...value, signature: await target.sign(offlineEventText(value)) };
  };
  const watch = async (purpose: "credit" | "catchup" | "send", operationId?: string) => {
    const start = await api<{ attemptId: string; readyAt: number }>("ads/start", { purpose, operationId }); assert.equal(start.status, 200, JSON.stringify(start.data));
    now += 6000; const result = await api("ads/complete", { attemptId: start.data.attemptId }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
  };
  return { db, sqlite, env, signing, device, api, intent, event, watch, now: () => now, advance(ms: number) { now += ms; } };
}

test("a sender earns one immutable send permit; receivers do not earn hourly access", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); const intent = await h.intent();
  const first = await h.api<PreparedSend>("sends/prepare", { intent });
  assert.equal(first.status, 200); assert.equal(first.data.adsRequired, 1); assert.equal(first.data.permit, null);
  const completed = await h.watch("send", intent.operationId);
  assert.equal(completed.kind, "none"); assert.equal(completed.expiresAt, null); assert.equal(completed.proof, null);
  const ready = await h.api<PreparedSend>("sends/prepare", { intent }); const permit = ready.data.permit!;
  assert.equal(ready.data.adsRequired, 0); assert.equal(permit.decision, "ad_completed");
  const [header, body, signature] = permit.proof!.split(".");
  const claims = JSON.parse(new TextDecoder().decode(unbase64url(body)));
  assert.equal(claims.v, 2); assert.equal(claims.purpose, "send"); assert.equal(claims.senderKeyThumbprint, await thumbprint(h.device.identity.publicKey));
  assert.equal(claims.exp, Math.floor(permit.expiresAt / 1000));
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, h.signing.publicKey, unbase64url(signature), new TextEncoder().encode(`${header}.${body}`)), true);
  const second = await h.api<PreparedSend>("sends/prepare", { intent: await h.intent() }); assert.equal(second.data.adsRequired, 1);
});

test("at most one ready credit exists while independent sends may each reserve a credit", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  const firstCredit = await h.watch("credit"); assert.equal(firstCredit.sendAccess?.creditAvailable, true);
  assert.equal((await h.api("ads/start", { purpose: "credit" })).status, 409);
  const a = await h.intent(); const b = await h.intent();
  assert.equal((await h.api<PreparedSend>("sends/prepare", { intent: a })).data.permit?.decision, "credit");
  await h.watch("credit"); assert.equal((await h.api<PreparedSend>("sends/prepare", { intent: b })).data.permit?.decision, "credit");
  const starts = await Promise.all([h.api<{ attemptId: string }>("ads/start", { purpose: "credit" }), h.api<{ attemptId: string }>("ads/start", { purpose: "credit" })]);
  h.advance(6000); const completes = await Promise.all(starts.map(start => h.api("ads/complete", { attemptId: start.data.attemptId })));
  assert.ok(completes.every(result => result.status === 200));
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='ready'").get() as { n: number }).n, 1);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='reserved'").get() as { n: number }).n, 2);
  await Promise.all([h.api("sends/commit", { operationId: a.operationId, status: "released" }), h.api("sends/commit", { operationId: b.operationId, status: "released" })]);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='ready'").get() as { n: number }).n, 1);
});

test("an inline send ad reserves a credit until verification and rejection makes it ready", async t => {
  const h=await harness();t.after(()=>h.sqlite.close());
  const original=await h.intent();await h.api('sends/prepare',{intent:original});await h.watch('send',original.operationId);
  const prepared=(await h.api<PreparedSend>('sends/prepare',{intent:original})).data;
  assert.equal(prepared.permit?.decision,'ad_completed');assert.ok(prepared.reservedCredit);assert.equal(prepared.sendAccess.creditAvailable,false);
  await Promise.all([h.api('sends/commit',{operationId:original.operationId,status:'released'}),h.api('sends/commit',{operationId:original.operationId,status:'released'})]);
  assert.equal((await h.api('access')).data.sendAccess?.creditAvailable,true);
  const next=await h.intent();const ready=(await h.api<PreparedSend>('sends/prepare',{intent:next})).data;
  assert.equal(ready.permit?.decision,'credit');assert.equal(ready.adsRequired,0);assert.equal(ready.reservedCredit?.id,prepared.reservedCredit?.id);
  await h.api('sends/commit',{operationId:next.operationId,status:'verified'});
  assert.equal((await h.api('access')).data.sendAccess?.creditAvailable,false);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='spent'").get() as {n:number}).n,1);
});

test("duplicate inline ad completions create one operation-bound credit", async t => {
  const h=await harness();t.after(()=>h.sqlite.close());const intent=await h.intent();await h.api('sends/prepare',{intent});
  const started=await h.api<{attemptId:string}>('ads/start',{purpose:'send',operationId:intent.operationId});h.advance(6000);
  await Promise.all([h.api('ads/complete',{attemptId:started.data.attemptId}),h.api('ads/complete',{attemptId:started.data.attemptId})]);
  assert.equal((h.sqlite.prepare('SELECT COUNT(*) AS n FROM market_send_credits').get() as {n:number}).n,1);
  const prepared=(await h.api<PreparedSend>('sends/prepare',{intent})).data;
  await h.api('sends/no-fill',{operationId:intent.operationId,reason:'provider_error'});
  const after=(await h.api('access')).data.sendAccess!;assert.equal(after.credit?.id,prepared.reservedCredit?.id);
  assert.equal(after.creditAvailable,true);
});

test("an ad completion racing a canceled send returns its earned credit", async t => {
  const h=await harness();t.after(()=>h.sqlite.close());const intent=await h.intent();await h.api('sends/prepare',{intent});
  const started=await h.api<{attemptId:string}>('ads/start',{purpose:'send',operationId:intent.operationId});h.advance(6000);
  await h.api('sends/commit',{operationId:intent.operationId,status:'released'});
  const completed=await h.api('ads/complete',{attemptId:started.data.attemptId});
  assert.equal(completed.data.sendAccess?.creditAvailable,true);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='reserved'").get() as {n:number}).n,0);
});

test("failed sends release once; immutable retries refresh without stealing another reservation", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.watch("credit");
  const a = await h.intent(); const b = await h.intent();
  const original = (await h.api<PreparedSend>("sends/prepare", { intent: a })).data;
  assert.equal((await h.api<{ sendAccess: SendAccessSummary }>("sends/commit", { operationId: a.operationId, status: "released" })).data.sendAccess.creditAvailable, true);
  assert.equal((await h.api("sends/commit", { operationId: a.operationId, status: "released" })).status, 200);
  await h.api("sends/prepare", { intent: b });
  h.advance(11 * 60_000);
  const retry = (await h.api<PreparedSend>("sends/prepare", { intent: { ...a, retryOf: a.operationId } })).data;
  assert.equal(retry.adsRequired, 0); assert.ok(retry.permit!.expiresAt > original.permit!.expiresAt);
  await h.api("sends/commit", { operationId: a.operationId, status: "verified" });
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='reserved'").get() as { n: number }).n, 1);
  await Promise.all([h.api("sends/commit", { operationId: b.operationId, status: "verified" }), h.api("sends/commit", { operationId: b.operationId, status: "verified" })]);
  await h.api("sends/commit", { operationId: b.operationId, status: "released" });
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='spent'").get() as { n: number }).n, 1);
  assert.equal((await h.api("access")).data.sendAccess?.creditAvailable, false);
  const changed = await h.intent({ ...a, files: [{ id: crypto.randomUUID(), size: 1 }] });
  assert.equal((await h.api("sends/prepare", { intent: changed })).status, 409);
});

test("offline receipts are owner-signed, idempotent and counted only once per successful batch", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); const intent = await h.intent(); const event = await h.event(intent);
  const results = await Promise.all([h.api<{ sendAccess: SendAccessSummary }>("usage/sync", { events: [event] }), h.api<{ sendAccess: SendAccessSummary }>("usage/sync", { events: [event] })]);
  assert.ok(results.every(result => result.status === 200)); assert.equal((await h.api("access")).data.sendAccess?.pendingOfflineAds, 1);
  assert.equal((await h.api("usage/sync", { events: [{ ...event, signature: "invalid" }] })).status, 401);
  const altered = await h.event(await h.intent({ operationId: intent.operationId }));
  assert.equal((await h.api("usage/sync", { events: [altered] })).status, 409);
  assert.equal((await h.api("usage/sync", { events: Array(101).fill(event) })).status, 400);
  assert.equal((await h.api("sends/prepare", { intent: { ...intent, files: [{ ...intent.files[0], name: "private-name.txt" }] } })).status, 400);
});

test("N offline sends require N catch-up ads before a prepared credit covers the next send", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  const events = await Promise.all([h.intent(), h.intent()].map(async intent => h.event(await intent)));
  await h.api("usage/sync", { events }); const send = await h.intent();
  assert.equal((await h.api<PreparedSend>("sends/prepare", { intent: send })).data.adsRequired, 3);
  await h.watch("credit");
  const reserved = (await h.api<PreparedSend>("sends/prepare", { intent: send })).data;
  assert.equal(reserved.pendingAds, 2); assert.equal(reserved.currentAds, 0); assert.equal(reserved.adsRequired, 2); assert.equal(reserved.permit, null);
  assert.equal((await h.api("sends/commit", { operationId: send.operationId, status: "verified" })).status, 409);
  await h.watch("catchup"); assert.equal((await h.api<PreparedSend>("sends/prepare", { intent: send })).data.adsRequired, 1);
  await h.watch("catchup"); const ready = (await h.api<PreparedSend>("sends/prepare", { intent: send })).data;
  assert.equal(ready.adsRequired, 0); assert.equal(ready.permit?.decision, "credit");
  await h.api("sends/commit", { operationId: send.operationId, status: "verified" });
  assert.equal((await h.api("access")).data.sendAccess?.pendingOfflineAds, 0);
});

test("one owned offline credit covers one event and cannot pay for another operation", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); const credit = (await h.watch("credit")).sendAccess!.credit!;
  const a = await h.intent(); const b = await h.intent();
  const events = [await h.event(a, credit.id), await h.event(b, credit.id)];
  const result = await h.api<{ sendAccess: SendAccessSummary }>("usage/sync", { events });
  assert.equal(result.status, 200); assert.equal(result.data.sendAccess.creditAvailable, false); assert.equal(result.data.sendAccess.pendingOfflineAds, 1);
  assert.equal((await h.api<{ sendAccess: SendAccessSummary }>("usage/sync", { events })).data.sendAccess.pendingOfflineAds, 1);
  const retry = await h.api<PreparedSend>("sends/prepare", { intent: a });
  assert.equal(retry.data.adsRequired, 0); assert.equal(retry.data.permit?.decision, "offline");
});

test("Premium clears backlog and its cutoff suppresses late pre-Premium events after expiry", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  await h.api("usage/sync", { events: [await h.event(await h.intent(), undefined, h.now() - 10_000)] });
  assert.equal((await h.api("access")).data.sendAccess?.pendingOfflineAds, 1);
  await h.api("auth/demo", { email: "premium@example.test", name: "Premium" });
  const order = await h.api<{ order: PublicOrder }>("orders", { planId: "month" }); await h.api(`orders/${order.data.order.id}/demo`, { outcome: "paid" });
  const paid = (await h.api("access")).data; assert.equal(paid.kind, "paid"); assert.equal(paid.sendAccess?.pendingOfflineAds, 0);
  const jwt = paid.proof!.split("."); assert.equal(JSON.parse(new TextDecoder().decode(unbase64url(jwt[1]))).v, 1);
  assert.equal((await h.api<PreparedSend>("sends/prepare", { intent: await h.intent() })).data.permit?.decision, "premium");
  const late = await h.event(await h.intent(), undefined, h.now() - 5000);
  h.advance(32 * 24 * 60 * 60_000);
  const synced = await h.api<{ sendAccess: SendAccessSummary }>("usage/sync", { events: [late, await h.event(await h.intent())] });
  assert.equal(synced.data.sendAccess.pendingOfflineAds, 1);
});

test("unavailable production advertising never blocks sending or grants a synthetic ad reward", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); const origin = "https://sharing.example";
  await h.api("usage/sync", { events: [await h.event(await h.intent())] }, h.device, origin);
  const ready = await h.api<PreparedSend>("sends/prepare", { intent: await h.intent() }, h.device, origin);
  assert.equal(ready.status, 200); assert.equal(ready.data.adsRequired, 0); assert.equal(ready.data.permit?.decision, "no_fill"); assert.equal(ready.data.sendAccess.pendingOfflineAds, 1);
  assert.equal(ready.data.sendAccess.strictCatchUp, false);
  assert.equal((await h.api("ads/start", { purpose: "credit" }, h.device, origin)).status, 503);
  const send = await h.intent(); await h.api("sends/prepare", { intent: send });
  const noFill = (await h.api<PreparedSend>("sends/no-fill", { operationId: send.operationId, reason: "timeout" })).data;
  assert.equal(noFill.decision, "no_fill"); assert.equal(noFill.permit?.decision, "no_fill"); assert.equal(noFill.adsRequired, 0); assert.equal(noFill.sendAccess.pendingOfflineAds, 1);
});

test("test ads enforce readiness and bind the attempt to one installation without duplicate rewards", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  const start = await h.api<{ attemptId: string }>("ads/start", { purpose: "credit" });
  assert.equal((await h.api("ads/complete", { attemptId: start.data.attemptId })).status, 409);
  h.advance(6000); assert.equal((await h.api("ads/complete", { attemptId: start.data.attemptId }, await installation())).status, 409);
  await Promise.all([h.api("ads/complete", { attemptId: start.data.attemptId }), h.api("ads/complete", { attemptId: start.data.attemptId })]);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits").get() as { n: number }).n, 1);
});

test("no-fill bypasses this batch while preserving two offline debts for a later healthy send", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  const receipts = [await h.event(await h.intent()), await h.event(await h.intent())];
  await h.api("usage/sync", { events: receipts }); const intent = await h.intent();
  assert.equal((await h.api<PreparedSend>("sends/prepare", { intent })).data.adsRequired, 3);
  const noFill = (await h.api<PreparedSend>("sends/no-fill", { operationId: intent.operationId, reason: "timeout" })).data;
  assert.equal(noFill.permit?.decision, "no_fill"); assert.equal(noFill.sendAccess.pendingOfflineAds, 2);
  const replay = await h.event(intent);
  const synced = await h.api<{ sendAccess: SendAccessSummary }>("usage/sync", { events: [replay] });
  assert.equal(synced.data.sendAccess.pendingOfflineAds, 2);
  assert.equal((await h.api<PreparedSend>("sends/prepare", { intent: await h.intent() })).data.adsRequired, 3);
});

test("no-fill returns a reserved current credit without erasing catch-up history", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  await h.api("usage/sync", { events: [await h.event(await h.intent())] }); await h.watch("credit");
  const intent = await h.intent(); await h.api("sends/prepare", { intent });
  const result = (await h.api<PreparedSend>("sends/no-fill", { operationId: intent.operationId, reason: "provider_error" })).data;
  assert.equal(result.permit?.decision, "no_fill"); assert.equal(result.sendAccess.creditAvailable, true); assert.equal(result.sendAccess.pendingOfflineAds, 1);
  const commit = await h.api<{ sendAccess: SendAccessSummary }>("sends/commit", { operationId: intent.operationId, status: "verified" });
  assert.equal(commit.data.sendAccess.creditAvailable, true);
  const next = (await h.api<PreparedSend>("sends/prepare", { intent: await h.intent() })).data;
  assert.equal(next.pendingAds, 1); assert.equal(next.currentAds, 0); assert.equal(next.adsRequired, 1);
});

test("lost online commit responses reconcile authorized ad, credit and no-fill sends without debt", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  for (const kind of ["ad_completed", "credit", "no_fill"] as const) {
    if (kind === "credit") await h.watch("credit");
    const intent = await h.intent(); await h.api("sends/prepare", { intent });
    if (kind === "ad_completed") await h.watch("send", intent.operationId);
    if (kind === "no_fill") await h.api("sends/no-fill", { operationId: intent.operationId, reason: "no_fill" });
    const ready = (await h.api<PreparedSend>("sends/prepare", { intent })).data;
    assert.equal(ready.permit?.decision, kind);
    const event = await h.event(intent);
    const sync = await h.api<{ sendAccess: SendAccessSummary }>("usage/sync", { events: [event] });
    assert.equal(sync.status, 200); assert.equal(sync.data.sendAccess.pendingOfflineAds, 0);
    await h.api("usage/sync", { events: [event] });
  }
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='spent'").get() as { n: number }).n, 2);
});

test("more than 100 offline events sync in bounded idempotent batches with exact pending IDs", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  const events = await Promise.all(Array.from({ length: 205 }, async () => h.event(await h.intent())));
  const first = await h.api<{ sendAccess: SendAccessSummary; acknowledgedOperationIds: string[] }>("usage/sync", { events: events.slice(0, 100) });
  assert.equal(first.status, 200); assert.equal(first.data.acknowledgedOperationIds.length, 100); assert.equal(first.data.sendAccess.pendingOfflineAds, 100);
  await h.api("usage/sync", { events: events.slice(0, 100) });
  await h.api("usage/sync", { events: events.slice(100, 200) });
  const final = await h.api<{ sendAccess: SendAccessSummary }>("usage/sync", { events: events.slice(200) });
  assert.equal(final.data.sendAccess.pendingOfflineAds, 205); assert.equal(final.data.sendAccess.pendingOperationIds?.length, 205); assert.equal(final.data.sendAccess.pendingOperationIdsComplete, true);
  assert.deepEqual(new Set(final.data.sendAccess.pendingOperationIds), new Set(events.map(event => event.operationId)));
});

test("send accounting accepts 100 GB per file and rejects larger or fractional sizes", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  const supported = await h.intent({ files: [0, 2 ** 32 + 17, MAX_FILE_BYTES, MAX_FILE_BYTES].map(size => ({ id: crypto.randomUUID(), size })) });
  assert.equal((await h.api("sends/prepare", { intent: supported })).status, 200);
  for (const size of [-1, 0.5, MAX_FILE_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
    const intent = await h.intent({ files: [{ id: crypto.randomUUID(), size }] });
    assert.equal((await h.api("sends/prepare", { intent })).status, 400, String(size));
  }
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_operations").get() as { n: number }).n, 1);
});

test("send accounting applies the same 500-file batch maximum as peers", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  const files = Array.from({ length: MAX_BATCH_FILES }, () => ({ id: crypto.randomUUID(), size: MAX_FILE_BYTES }));
  assert.equal((await h.api("sends/prepare", { intent: await h.intent({ files }) })).status, 200);
  assert.equal((await h.api("sends/prepare", { intent: await h.intent({ files: [...files, { id: crypto.randomUUID(), size: 1 }] }) })).status, 400);
});

test("an accepted long-running send verifies after its short offer permit expires, accounting once", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.watch("credit");
  const intent = await h.intent({ files: [{ id: crypto.randomUUID(), size: MAX_FILE_BYTES }] });
  const ready = (await h.api<PreparedSend>("sends/prepare", { intent })).data;
  assert.equal(ready.permit?.decision, "credit");
  h.advance(3 * 24 * 60 * 60_000);
  assert.ok(h.now() > ready.permit!.expiresAt);
  await Promise.all([h.api("sends/commit", { operationId: intent.operationId, status: "verified" }), h.api("sends/commit", { operationId: intent.operationId, status: "verified" })]);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_send_credits WHERE status='spent'").get() as { n: number }).n, 1);
  assert.equal((await h.api("access")).data.sendAccess?.pendingOfflineAds, 0);
});

test("Premium expiry affects new sends without charging again for an already authorized send", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  await h.api("auth/demo", { email: "long-send@example.test", name: "Long sender" });
  const order = await h.api<{ order: PublicOrder }>("orders", { planId: "month" });
  await h.api(`orders/${order.data.order.id}/demo`, { outcome: "paid" });
  const intent = await h.intent({ files: [{ id: crypto.randomUUID(), size: MAX_FILE_BYTES }] });
  assert.equal((await h.api<PreparedSend>("sends/prepare", { intent })).data.permit?.decision, "premium");
  h.advance(32 * 24 * 60 * 60_000);
  assert.equal((await h.api("sends/commit", { operationId: intent.operationId, status: "verified" })).status, 200);
  assert.equal((await h.api("access")).data.sendAccess?.pendingOfflineAds, 0);
  assert.equal((await h.api<PreparedSend>("sends/prepare", { intent: await h.intent() })).data.adsRequired, 1);
});
