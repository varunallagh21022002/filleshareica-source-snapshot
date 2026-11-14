import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AccessState, DeviceAssertion, DeviceIdentity, PublicOrder } from "../lib/market/types";
import { addPlanMonths } from "../lib/market/plans";
import { MarketService, marketConfig, type MarketEnvironment } from "../lib/server/market";
import { base64url, clearGoogleKeyCache, verifyGoogleToken } from "../lib/server/market-crypto";

const NOW = Date.UTC(2026, 0, 31, 13, 14, 15, 123);
const origin = "http://127.0.0.1:5173";
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
async function device(deviceClass: "desktop" | "mobile" = "desktop") {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const identity: DeviceIdentity = { installationId: crypto.randomUUID(), deviceClass, label: `Test ${deviceClass}`, publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey) };
  return { identity, async assertion(now = NOW): Promise<DeviceAssertion> {
    const nonce = crypto.randomUUID(); const message = `fileshare-device-v1:${identity.installationId}:${now}:${nonce}`;
    return { device: identity, timestamp: now, nonce, signature: base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(message)))) };
  } };
}
async function harness() {
  const { db, sqlite } = database(); const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const env: MarketEnvironment = { MARKET_DEV_MODE: "1", MARKET_SIGNING_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", signing.privateKey)) };
  const installation = await device();
  let fetcher: typeof fetch | undefined;
  const cookieByDevice = new Map<string, string>();
  const api = async <T = AccessState>(path: string, body: Record<string, unknown> = {}, options: { now?: number; dev?: Awaited<ReturnType<typeof device>>; method?: string; origin?: string; headers?: Record<string, string>; raw?: string } = {}) => {
    const now = options.now ?? NOW; const dev = options.dev ?? installation;
    const method = options.method ?? "POST";
    const url = `${options.origin ?? origin}/api/market/${path}`;
    const headers = { "content-type": "application/json", origin: options.origin ?? origin, cookie: cookieByDevice.get(dev.identity.installationId) ?? "", ...options.headers };
    const payload = options.raw ?? JSON.stringify({ ...body, assertion: body.assertion ?? await dev.assertion(now) });
    const request = new Request(url, { method, headers, ...(method !== "GET" ? { body: payload } : {}) });
    const response = await new MarketService(db, env, request, now, fetcher).dispatch(path);
    const setCookie = response.headers.get("set-cookie"); if (setCookie) cookieByDevice.set(dev.identity.installationId, setCookie.split(";")[0]);
    return { status: response.status, data: await response.json() as T, response };
  };
  const login = (dev = installation, now = NOW) => api("auth/demo", { email: "owner@example.test", name: "Owner" }, { dev, now });
  return { db, sqlite, signing, env, installation, api, login, setFetcher(value: typeof fetch) { fetcher = value; } };
}

test("local demo is explicit and never enabled on a public hostname", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  assert.equal(marketConfig({}, new Request(origin)).paymentMode, "disabled");
  assert.equal(marketConfig(h.env, new Request("https://public.example")).development, false);
  assert.equal((await h.api("auth/demo", { email: "owner@example.test" }, { origin: "https://public.example" })).status, 404);
  assert.equal((await h.api("ads/start", { purpose: "credit" }, { origin: "https://public.example" })).status, 503);
});

test("installation proof rejects tampering, replay, stale timestamp and cross-origin mutation", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  const assertion = await h.installation.assertion();
  assert.equal((await h.api("access", { assertion })).status, 200);
  assert.equal((await h.api("access", { assertion })).status, 409);
  assert.equal((await h.api("access", { assertion: await h.installation.assertion(NOW - 6 * 60_000) })).status, 401);
  const tampered = await h.installation.assertion(); tampered.device = { ...tampered.device, installationId: crypto.randomUUID() };
  assert.equal((await h.api("access", { assertion: tampered })).status, 401);
  assert.equal((await h.api("access", {}, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await h.api("access", {}, { headers: { origin: "" } })).status, 403);
});

test("policy migration retires old hour passes and grace without converting them to credits", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  await h.api("access");
  h.sqlite.prepare("UPDATE market_installations SET ad_until=?,grace_until=?").run(NOW + 3600000, NOW + 3600000);
  const state = await h.api("access");
  assert.equal(state.data.kind, "none"); assert.equal(state.data.proof, null);
  assert.equal(state.data.sendAccess?.creditAvailable, false); assert.equal(state.data.config.advertisingPolicyVersion, 2);
  assert.equal((await h.api("access/grace")).status, 409);
  assert.equal((await h.api("ads/start")).status, 409);
});

test("payments use owned server prices, grant exactly once and clamp calendar months", async t => {
  const h = await harness(); t.after(() => h.sqlite.close());
  assert.equal((await h.api("orders", { planId: "month" })).status, 401);
  const login = await h.login(); assert.equal(login.status, 200); assert.match(login.response.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const order = await h.api<{ order: PublicOrder }>("orders", { planId: "month", amountPaise: 1 });
  assert.equal(order.data.order.amountPaise, 3000);
  assert.equal((await h.api(`orders/${order.data.order.id}/demo`, { outcome: "paid" })).status, 200);
  assert.equal((await h.api(`orders/${order.data.order.id}/demo`, { outcome: "paid" })).status, 200);
  const access = (await h.api("access")).data;
  assert.equal(access.paidUntil, addPlanMonths(NOW, "month")); assert.equal(access.kind, "paid"); assert.equal(access.hyperSpeed, true);
  assert.equal(access.expiresAt, NOW + 24 * 60 * 60_000);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_grants").get() as { n: number }).n, 1);
  const order2 = await h.api<{ order: PublicOrder }>("orders", { planId: "six_months" });
  await h.api(`orders/${order2.data.order.id}/demo`, { outcome: "paid" });
  assert.equal((await h.api("access")).data.paidUntil, addPlanMonths(addPlanMonths(NOW, "month"), "six_months"));
  const stranger = await device(); assert.equal((await h.api(`orders/${order.data.order.id}`, {}, { method: "GET", dev: stranger })).status, 401);
});

test("two device slots cannot be stolen; replacement requires fresh login and cooldown", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); const mobile = await device("mobile"); const otherDesktop = await device(); const thirdDesktop = await device();
  await h.login(); await h.login(mobile); const third = await h.login(otherDesktop);
  assert.equal(third.data.deviceStatus, "replacement_required"); assert.equal(third.data.devices.length, 2);
  assert.equal((await h.api("devices/enroll", {}, { dev: otherDesktop })).data.deviceStatus, "replacement_required");
  assert.equal((await h.api("devices/replace", {}, { dev: otherDesktop, now: NOW + 6 * 60_000 })).status, 401);
  await h.login(otherDesktop, NOW + 6 * 60_000);
  const replacement = await h.api("devices/replace", {}, { dev: otherDesktop, now: NOW + 6 * 60_000 });
  assert.equal(replacement.status, 200); assert.equal(replacement.data.deviceStatus, "registered");
  await h.login(thirdDesktop, NOW + 6 * 60_000);
  assert.equal((await h.api("devices/replace", {}, { dev: thirdDesktop, now: NOW + 6 * 60_000 })).status, 429);
  assert.equal((await h.api("access", {}, { dev: otherDesktop, now: NOW + 6 * 60_000 })).data.deviceStatus, "registered");
});

test("demo refunds require a duplicate and rebuild only the remaining calendar grants", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  const buy = async (planId: string) => {
    const order = (await h.api<{ order: PublicOrder }>("orders", { planId })).data.order;
    await h.api(`orders/${order.id}/demo`, { outcome: "paid" }); return order;
  };
  const first = await buy("month");
  assert.equal((await h.api(`orders/${first.id}/refund`)).status, 409);
  const duplicate = await buy("month"); await buy("six_months");
  assert.equal((await h.api(`orders/${duplicate.id}/refund`)).status, 200);
  assert.equal((await h.api(`orders/${duplicate.id}/refund`)).status, 200);
  assert.equal((await h.api("access")).data.paidUntil, addPlanMonths(addPlanMonths(NOW, "month"), "six_months"));
});

test("concurrent purchase callbacks and duplicate refunds preserve exactly one remaining grant", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  const orders = await Promise.all([h.api<{ order: PublicOrder }>("orders", { planId: "month" }), h.api<{ order: PublicOrder }>("orders", { planId: "month" })]);
  const ids = orders.map(o => o.data.order.id);
  const paid = await Promise.all(ids.flatMap(id => [h.api(`orders/${id}/demo`, { outcome: "paid" }), h.api(`orders/${id}/demo`, { outcome: "paid" })]));
  assert.ok(paid.every(r => r.status === 200));
  assert.equal((await h.api("access")).data.paidUntil, addPlanMonths(addPlanMonths(NOW, "month"), "month"));
  const refunds = await Promise.all(ids.map(id => h.api(`orders/${id}/refund`)));
  assert.deepEqual(refunds.map(r => r.status).sort(), [200, 409]);
  assert.equal((await h.api("access")).data.paidUntil, addPlanMonths(NOW, "month"));
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_orders WHERE status='paid'").get() as { n: number }).n, 1);
});

test("configured checkout keeps secrets private and uses the agreed return URL and server amount", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  h.env.CASHFREE_CLIENT_ID = "private-client-id"; h.env.CASHFREE_CLIENT_SECRET = "synthetic-test-secret"; h.env.CASHFREE_MODE = "sandbox"; h.env.MARKET_PUBLIC_ORIGIN = "https://share.example";
  let calls = 0;
  h.setFetcher((async (url: string | URL | Request, init?: RequestInit) => {
    calls++; assert.equal(url, "https://sandbox.cashfree.com/pg/orders");
    const headers = init?.headers as Record<string, string>;
    assert.match(headers["x-idempotency-key"], /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.order_amount, 30); assert.equal(body.order_currency, "INR");
    assert.equal(body.order_meta.return_url, `https://share.example/payment/return?order_id=${body.order_id}`);
    assert.equal(body.order_meta.notify_url, "https://share.example/api/market/webhooks/cashfree");
    assert.equal(body.customer_details.customer_phone, "9876543210");
    return Response.json({ order_id: body.order_id, payment_session_id: "provider-session" });
  }) as typeof fetch);
  const config = marketConfig(h.env, new Request(origin));
  assert.equal(config.paymentMode, "sandbox"); assert.equal(config.publicKey?.d, undefined);
  assert.ok(!JSON.stringify(config).includes("private-merchant-secret"));
  assert.ok(!JSON.stringify(config).includes("private-client-id"));
  assert.equal((await h.api("orders", { planId: "month" })).status, 400);
  const checkout = await h.api<{ order: PublicOrder }>("orders", { planId: "month", amountPaise: 1, customerPhone: "+919876543210" });
  assert.equal(checkout.status, 200); assert.equal(checkout.data.order.checkoutSessionId, "provider-session"); assert.equal(calls, 1);
  assert.equal((await h.api(`orders/${checkout.data.order.id}/demo`, { outcome: "paid" })).status, 403);
});

test("an interrupted Cashfree creation recovers the same order and blocks a different pending plan", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  Object.assign(h.env, { CASHFREE_CLIENT_ID: "test-client", CASHFREE_CLIENT_SECRET: "test-secret", CASHFREE_MODE: "sandbox", MARKET_PUBLIC_ORIGIN: "https://share.example" });
  let createdId = ""; let creates = 0; let lookups = 0; let paid = false;
  h.setFetcher((async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") { creates++; createdId = JSON.parse(String(init.body)).order_id; throw new Error("Ambiguous network disconnect after provider creation"); }
    if (String(url).endsWith("/payments")) return Response.json([{ cf_payment_id: "2345", payment_status: "SUCCESS", payment_amount: 30, payment_currency: "INR" }]);
    lookups++; assert.equal(String(url), `https://sandbox.cashfree.com/pg/orders/${createdId}`);
    return Response.json({ order_id: createdId, order_amount: 30, order_currency: "INR", order_status: paid ? "PAID" : "ACTIVE", payment_session_id: "recovered-session" });
  }) as typeof fetch);
  const body = { planId: "month", customerPhone: "9876543210" };
  assert.equal((await h.api("orders", body)).status, 503);
  const recovered = await h.api<{ order: PublicOrder }>("orders", body);
  assert.equal(recovered.status, 200); assert.equal(recovered.data.order.id, createdId); assert.equal(recovered.data.order.checkoutSessionId, "recovered-session");
  assert.equal((await h.api("orders", { ...body, planId: "year" })).status, 409);
  paid = true;
  const confirmed = await h.api<{ order: PublicOrder }>("orders", body);
  assert.equal(confirmed.data.order.status, "paid"); assert.equal(confirmed.data.order.id, createdId);
  assert.equal(creates, 1); assert.equal(lookups, 3);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_orders").get() as { n: number }).n, 1);
});

test("definitively missing Cashfree creation retries the original ID and idempotency key", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  Object.assign(h.env, { CASHFREE_CLIENT_ID: "test-client", CASHFREE_CLIENT_SECRET: "test-secret", CASHFREE_MODE: "sandbox", MARKET_PUBLIC_ORIGIN: "https://share.example" });
  const ids: string[] = []; const keys: string[] = [];
  h.setFetcher((async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
    const body = JSON.parse(String(init.body)); ids.push(body.order_id); keys.push((init.headers as Record<string, string>)["x-idempotency-key"]);
    if (ids.length === 1) throw new Error("Connection failed before provider creation");
    return Response.json({ order_id: body.order_id, payment_session_id: "same-order-session" });
  }) as typeof fetch);
  const body = { planId: "month", customerPhone: "9876543210" };
  assert.equal((await h.api("orders", body)).status, 503);
  assert.equal((await h.api("orders", body)).status, 200);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 1); assert.equal(new Set(keys).size, 1);
});

test("concurrent Cashfree checkout requests cannot create two pending orders", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  Object.assign(h.env, { CASHFREE_CLIENT_ID: "test-client", CASHFREE_CLIENT_SECRET: "test-secret", CASHFREE_MODE: "sandbox", MARKET_PUBLIC_ORIGIN: "https://share.example" });
  const provisioned = new Map<string, Record<string, unknown>>();
  h.setFetcher((async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const result = { order_id: body.order_id, order_amount: body.order_amount, order_currency: body.order_currency, order_status: "ACTIVE", payment_session_id: "single-session" };
      provisioned.set(body.order_id, result); return Response.json(result);
    }
    const result = provisioned.get(String(url).split("/").at(-1)!);
    return result ? Response.json(result) : Response.json({}, { status: 404 });
  }) as typeof fetch);
  const body = { planId: "month", customerPhone: "9876543210" };
  const results = await Promise.all([h.api<{ order: PublicOrder }>("orders", body), h.api<{ order: PublicOrder }>("orders", body)]);
  assert.ok(results.every(result => result.status === 200)); assert.equal(new Set(results.map(r => r.data.order.id)).size, 1);
  assert.equal(provisioned.size, 1);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_orders WHERE status='pending' AND provider='cashfree'").get() as { n: number }).n, 1);
});

test("account deletion requires fresh auth and removes identity while retaining minimal billing", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  const order = await h.api<{ order: PublicOrder }>("orders", { planId: "year" });
  await h.api(`orders/${order.data.order.id}/demo`, { outcome: "paid" });
  assert.equal((await h.api("account/delete", {}, { now: NOW + 6 * 60_000 })).status, 401);
  await h.login(h.installation, NOW + 6 * 60_000);
  assert.equal((await h.api("account/delete", {}, { now: NOW + 6 * 60_000 })).status, 200);
  assert.equal((await h.api("access", {}, { now: NOW + 6 * 60_000 })).data.account, null);
  const account = h.sqlite.prepare("SELECT * FROM market_accounts").get() as { email: string; google_subject: string; paid_until: number };
  assert.equal(account.email, ""); assert.match(account.google_subject, /^deleted:/); assert.equal(account.paid_until, 0);
  assert.equal((h.sqlite.prepare("SELECT COUNT(*) AS n FROM market_orders").get() as { n: number }).n, 1);
});

test("delayed confirmation after deletion records the payment without restoring deleted access", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  const order = (await h.api<{ order: PublicOrder }>("orders", { planId: "year" })).data.order;
  assert.equal((await h.api("account/delete")).status, 200);
  const service = new MarketService(h.db, h.env, new Request(origin), NOW + 1000);
  await service.grantPayment(order.id, `demo:${order.id}`, order.amountPaise, "INR", "demo");
  assert.equal((h.sqlite.prepare("SELECT paid_until FROM market_accounts").get() as { paid_until: number }).paid_until, 0);
  assert.equal((h.sqlite.prepare("SELECT status FROM market_orders WHERE id=?").get(order.id) as { status: string }).status, "paid");
  assert.equal((await h.api("access")).data.allowed, false);
});

test("signed Cashfree events reject wrong amount and grant once after failed attempts", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); await h.login();
  const order = (await h.api<{ order: PublicOrder }>("orders", { planId: "month" })).data.order;
  h.sqlite.prepare("UPDATE market_orders SET provider='cashfree',status='failed' WHERE id=?").run(order.id);
  h.env.CASHFREE_CLIENT_SECRET = "synthetic-test-secret"; h.env.CASHFREE_MODE = "sandbox";
  const call = async (amount: number, valid = true) => {
    const raw = JSON.stringify({ data: { order: { order_id: order.id, order_amount: amount, order_currency: "INR" }, payment: { cf_payment_id: 1234, payment_status: "SUCCESS", payment_amount: amount, payment_currency: "INR" } } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(h.env.CASHFREE_CLIENT_SECRET!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(NOW) + raw)))));
    return h.api("webhooks/cashfree", {}, { raw, headers: { "x-webhook-timestamp": String(NOW), "x-webhook-signature": valid ? signature : "wrong" } });
  };
  assert.equal((await call(30, false)).status, 401); assert.equal((await call(1)).status, 400);
  const duplicates = await Promise.all([call(30), call(30), call(30)]);
  assert.ok(duplicates.every(result => result.status === 200));
  assert.equal((await h.api("access")).data.paidUntil, addPlanMonths(NOW, "month"));
});

test("replaying an older valid Google credential cannot refresh sensitive-action authentication", async t => {
  const h = await harness(); t.after(() => h.sqlite.close()); clearGoogleKeyCache();
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "freshness-key" };
  h.env.GOOGLE_CLIENT_ID = "freshness-client";
  h.setFetcher((async () => Response.json({ keys: [jwk] })) as typeof fetch);
  const token = async (issuedAt: number) => {
    const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "freshness-key" })));
    const payload = base64url(new TextEncoder().encode(JSON.stringify({ sub: "freshness-user", email: "google@example.test", name: "Google member", email_verified: true, iss: "https://accounts.google.com", aud: "freshness-client", iat: issuedAt / 1000, exp: NOW / 1000 + 3600 })));
    const input = `${header}.${payload}`;
    return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input))))}`;
  };
  const older = await token(NOW - 10 * 60_000);
  assert.equal((await h.api("auth/google", { credential: older })).status, 200);
  assert.equal((await h.api("account/delete")).status, 401);
  assert.equal((await h.api("auth/google", { credential: older })).status, 200);
  assert.equal((await h.api("account/delete")).status, 401);
  assert.equal((await h.api("auth/google", { credential: await token(NOW) })).status, 200);
  assert.equal((await h.api("account/delete")).status, 200); clearGoogleKeyCache();
});

test("Google identity verification checks signature, audience, issuer and expiry with cached keys", async () => {
  clearGoogleKeyCache();
  const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", rsa.publicKey), kid: "test-key" }; let fetched = 0;
  const fetcher = (async () => { fetched++; return Response.json({ keys: [jwk] }, { headers: { "cache-control": "public,max-age=3600" } }); }) as typeof fetch;
  const token = async (overrides: Record<string, unknown> = {}) => {
    const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-key" })));
    const payload = base64url(new TextEncoder().encode(JSON.stringify({ sub: "123", email: "owner@example.test", name: "Owner", email_verified: true, iss: "https://accounts.google.com", aud: "client-id", iat: NOW / 1000 - 1, exp: NOW / 1000 + 3600, ...overrides })));
    return `${header}.${payload}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(`${header}.${payload}`))))}`;
  };
  assert.equal((await verifyGoogleToken(await token(), "client-id", NOW, fetcher)).sub, "123");
  await assert.rejects(verifyGoogleToken(await token({ aud: "other" }), "client-id", NOW, fetcher));
  await assert.rejects(verifyGoogleToken(await token({ iss: "https://evil.example" }), "client-id", NOW, fetcher));
  await assert.rejects(verifyGoogleToken(await token({ exp: NOW / 1000 - 1 }), "client-id", NOW, fetcher));
  const tampered = (await token()).split(".");
  tampered[1] = base64url(new TextEncoder().encode(JSON.stringify({ sub: "attacker", email: "intruder@example.test", name: "Intruder", email_verified: true, iss: "https://accounts.google.com", aud: "client-id", iat: NOW / 1000 - 1, exp: NOW / 1000 + 3600 })));
  await assert.rejects(verifyGoogleToken(tampered.join("."), "client-id", NOW, fetcher));
  assert.equal(fetched, 1); clearGoogleKeyCache();
});
