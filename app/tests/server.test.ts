import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionService } from "../lib/server/sessions";
import {
  ApiError, IDLE_TTL_MS, INVITE_TTL_MS, MAX_BODY_BYTES, MAX_SIGNAL_BYTES,
  parseCursor, readBody, requireSameOrigin, sha256, validateDeviceName, validatePayload, validateSessionName,
} from "../lib/server/policy";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(new URL("../drizzle/", import.meta.url)).filter((file) => file.endsWith(".sql")).sort();
  assert.ok(files.length, "Generate the D1 migration before running backend tests.");
  for (const file of files) sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const prepare = (sql: string) => {
    let values: (string | number | null)[] = [];
    const execute = () => {
      if (/\bRETURNING\b|^SELECT\b/i.test(sql)) return { results: sqlite.prepare(sql).all(...values), success: true };
      sqlite.prepare(sql).run(...values);
      return { results: [], success: true };
    };
    const statement = {
      bind(...args: (string | number | null)[]) { values = args; return statement; },
      async first<T>() { return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[], success: true }; },
      async run() { return execute(); },
      execute,
    };
    return statement;
  };
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const output = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return output;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

const NOW = 1_700_000_000_000;

async function pair(service: SessionService) {
  const joinHash = await sha256("an independently generated 256-bit invitation secret");
  const host = await service.create({ deviceName: "Laptop", joinHash }, "192.0.2.1");
  const guest = await service.join(host.sessionId, { deviceName: "Phone", joinHash }, "192.0.2.2");
  return { host, guest, joinHash };
}

test("pairing requires host approval and allows encrypted signaling in both directions", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const { host, guest } = await pair(service);
  assert.equal((await service.poll(host.sessionId, host.token, 0)).status, "pending");
  assert.equal((await service.poll(host.sessionId, guest.token, 0)).peerName, "Laptop");
  await assert.rejects(service.signal(host.sessionId, guest.token, "encrypted-offer"), (error: unknown) => error instanceof ApiError && error.status === 409);
  await assert.rejects(service.approve(host.sessionId, guest.token, true), (error: unknown) => error instanceof ApiError && error.status === 403);
  await service.approve(host.sessionId, host.token, true);
  const outgoing = await service.signal(host.sessionId, host.token, "encrypted-offer");
  const guestPoll = await service.poll(host.sessionId, guest.token, 0);
  assert.equal(guestPoll.status, "approved");
  assert.deepEqual(guestPoll.signals.map((message) => ({ ...message })), [{ id: outgoing.id, payload: "encrypted-offer" }]);
  assert.equal(guestPoll.relayAvailable, false);
  assert.equal((await service.poll(host.sessionId, host.token, 0)).signals.length, 0);
  await service.signal(host.sessionId, guest.token, "encrypted-answer");
  assert.equal((await service.poll(host.sessionId, host.token, 0)).signals[0].payload, "encrypted-answer");
  assert.equal((await service.poll(host.sessionId, guest.token, outgoing.id)).signals.length, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM signals WHERE target_role = 'guest'").get() as { count: number }).count, 0);
});

test("only one guest can atomically claim an invitation", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const joinHash = await sha256("secret");
  const host = await service.create({ deviceName: "Laptop", joinHash }, "192.0.2.1");
  const results = await Promise.allSettled([
    service.join(host.sessionId, { deviceName: "Phone one", joinHash }, "192.0.2.2"),
    service.join(host.sessionId, { deviceName: "Phone two", joinHash }, "192.0.2.3"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("tokens are stored as hashes, wrong secrets fail, and strangers cannot read a room", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const joinHash = await sha256("secret");
  const host = await service.create({ deviceName: "Laptop", joinHash }, "192.0.2.1");
  const stored = sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(host.sessionId) as { host_token_hash: string };
  assert.notEqual(stored.host_token_hash, host.token);
  assert.equal(stored.host_token_hash, await sha256(host.token));
  await assert.rejects(service.join(host.sessionId, { deviceName: "Intruder", joinHash: "0".repeat(64) }, "192.0.2.3"), (error: unknown) => error instanceof ApiError && error.status === 404);
  await assert.rejects(service.poll(host.sessionId, "0".repeat(64), 0), (error: unknown) => error instanceof ApiError && error.status === 401);
  await assert.rejects(service.poll(host.sessionId, null, 0), (error: unknown) => error instanceof ApiError && error.status === 401);
});

test("unvisited invitations expire while polling keeps waiting, pending, and approved sessions alive", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const host = await service.create({ deviceName: "Laptop", joinHash: await sha256("unused") }, "192.0.2.1");
  const late = new SessionService(db, {}, NOW + INVITE_TTL_MS + 1);
  await assert.rejects(late.poll(host.sessionId, host.token, 0), (error: unknown) => error instanceof ApiError && error.status === 410);
  const second = await service.create({ deviceName: "Second", joinHash: await sha256("second") }, "192.0.2.4");
  assert.equal((await service.poll(second.sessionId, second.token, 0)).expiresAt, NOW + IDLE_TTL_MS);
  assert.equal((await late.poll(second.sessionId, second.token, 0)).status, "waiting");
  await service.join(second.sessionId, { deviceName: "Phone", joinHash: await sha256("second") }, "192.0.2.5");
  assert.equal((await late.poll(second.sessionId, second.token, 0)).status, "pending");
  await service.approve(second.sessionId, second.token, true);
  const refreshed = await late.poll(second.sessionId, second.token, 0);
  assert.equal(refreshed.expiresAt, NOW + INVITE_TTL_MS + 1 + IDLE_TTL_MS);
});

test("named short links claim the same session and do not replace the invitation proof", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const joinHash = await sha256("private invitation");
  const host = await service.create({ deviceName: "Laptop", sessionName: "  Café files  ", joinHash }, "192.0.2.1");
  assert.equal(host.sessionName, "Café files");
  assert.match(host.slug, /^[a-f0-9]{6}$/);
  await assert.rejects(service.join(host.slug, { deviceName: "Stranger", joinHash: "0".repeat(64) }, "192.0.2.3"), (error: unknown) => error instanceof ApiError && error.status === 404);
  const guest = await service.join(host.slug, { deviceName: "Phone", joinHash }, "192.0.2.2");
  assert.equal(guest.sessionId, host.sessionId);
  assert.equal(guest.slug, host.slug);
  assert.equal(guest.sessionName, host.sessionName);
  assert.equal(guest.connectionRevision, 0);
  const poll = await service.poll(host.sessionId, host.token, 0);
  assert.equal(poll.slug, host.slug);
  assert.equal(poll.sessionName, host.sessionName);
  await assert.rejects(service.poll(host.slug, host.token, 0), (error: unknown) => error instanceof ApiError && error.status === 404);
});

test("session names are optional, bounded, and independently get unique slugs", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const body = { deviceName: "Laptop", joinHash: await sha256("secret") };
  const defaultSession = await service.create(body, "192.0.2.1");
  assert.equal(defaultSession.sessionName, null);
  assert.match(defaultSession.slug, /^[a-f0-9]{6}$/);
  const one = await service.create({ ...body, sessionName: "Files" }, "192.0.2.1");
  const two = await service.create({ ...body, sessionName: "Files" }, "192.0.2.1");
  assert.notEqual(one.slug, two.slug);
  assert.equal(validateSessionName("\u0000  "), null);
  assert.throws(() => validateSessionName("a".repeat(41)), ApiError);
  assert.throws(() => validateSessionName({ name: "Files" }), ApiError);
});

test("refresh resumes an approved session without reapproval and atomically replaces old signaling", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const { host, guest } = await pair(service);
  await service.approve(host.sessionId, host.token, true);
  await service.signal(host.sessionId, host.token, "old encrypted offer", 0);
  await service.signal(host.sessionId, guest.token, "old encrypted answer", 0);
  await assert.rejects(service.resume(host.sessionId, "0".repeat(64)), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM signals").get() as { count: number }).count, 2);
  const resumed = await service.resume(host.sessionId, guest.token);
  assert.equal(resumed.sessionId, host.sessionId);
  assert.equal(resumed.role, "guest");
  assert.equal(resumed.status, "approved");
  assert.equal(resumed.connectionRevision, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM signals").get() as { count: number }).count, 0);
  const hostPoll = await service.poll(host.sessionId, host.token, 0);
  assert.equal(hostPoll.status, "approved");
  assert.equal(hostPoll.connectionRevision, 1);
  await assert.rejects(service.signal(host.sessionId, host.token, "stale offer", 0), (error: unknown) => error instanceof ApiError && error.status === 409);
  const current = await service.signal(host.sessionId, host.token, "fresh offer", 1);
  assert.equal((await service.poll(host.sessionId, guest.token, 0)).signals[0].id, current.id);
  // Older frontends can still exchange opaque payloads during rolling deploys.
  await service.signal(host.sessionId, guest.token, "legacy client answer");
});

test("concurrent refreshes each advance the shared revision and closed sessions cannot resume", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const { host, guest } = await pair(service);
  const pending = await service.resume(host.sessionId, host.token);
  assert.equal(pending.status, "pending");
  assert.equal(pending.connectionRevision, 1);
  await service.approve(host.sessionId, host.token, true);
  const results = await Promise.all([
    service.resume(host.sessionId, host.token),
    service.resume(host.sessionId, guest.token),
  ]);
  assert.deepEqual(results.map((result) => result.connectionRevision).sort(), [2, 3]);
  assert.equal((await service.poll(host.sessionId, host.token, 0)).connectionRevision, 3);
  await service.leave(host.sessionId, host.token);
  await assert.rejects(service.resume(host.sessionId, guest.token), (error: unknown) => error instanceof ApiError && error.status === 409);
});

test("closing a session deletes signaling and prevents subsequent sends", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  const { host, guest } = await pair(service);
  await service.approve(host.sessionId, host.token, true);
  await service.signal(host.sessionId, host.token, "ciphertext");
  await service.leave(host.sessionId, guest.token);
  assert.equal((await service.poll(host.sessionId, host.token, 0)).status, "closed");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM signals").get() as { count: number }).count, 0);
  await assert.rejects(service.signal(host.sessionId, host.token, "ciphertext"), (error: unknown) => error instanceof ApiError && error.status === 409);
});

test("session creation rate limit bounds anonymous abuse", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, {}, NOW);
  for (let count = 0; count < 12; count++) await service.create({ deviceName: "Laptop", joinHash: "a".repeat(64) }, "192.0.2.1");
  await assert.rejects(service.create({ deviceName: "Laptop", joinHash: "a".repeat(64) }, "192.0.2.1"), (error: unknown) => error instanceof ApiError && error.status === 429 && Boolean(error.retryAfter));
});

test("TURN credential generation is cached and exposes no server management token", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  let requests = 0;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer private-server-token");
    return Response.json({ iceServers: { urls: ["turn:example.org:3478"], username: "temporary", credential: "temporary-secret" } });
  }) as typeof fetch;
  const service = new SessionService(db, { CLOUDFLARE_TURN_KEY_ID: "key", CLOUDFLARE_TURN_API_TOKEN: "private-server-token" }, NOW, fetcher);
  const { host } = await pair(service);
  await service.approve(host.sessionId, host.token, true);
  const first = await service.poll(host.sessionId, host.token, 0);
  const second = await service.poll(host.sessionId, host.token, 0);
  assert.equal(first.relayAvailable, true);
  assert.equal(second.relayAvailable, true);
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(first).includes("private-server-token"));
});

test("failed optional TURN service preserves direct connectivity", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new SessionService(db, { CLOUDFLARE_TURN_KEY_ID: "key", CLOUDFLARE_TURN_API_TOKEN: "token" }, NOW, (async () => { throw new Error("offline"); }) as typeof fetch);
  const { host } = await pair(service);
  await service.approve(host.sessionId, host.token, true);
  const result = await service.poll(host.sessionId, host.token, 0);
  assert.equal(result.relayAvailable, false);
  assert.deepEqual(result.iceServers, [{ urls: "stun:stun.cloudflare.com:3478" }]);
});

test("request validation bounds cursors, Unicode message bytes, JSON bodies, and cross-site requests", async () => {
  assert.equal(validateDeviceName("  Phone\u0000  "), "Phone");
  assert.equal(parseCursor(null), 0);
  assert.equal(parseCursor("42"), 42);
  assert.throws(() => parseCursor("-1"), ApiError);
  assert.throws(() => parseCursor("9007199254740992"), ApiError);
  assert.equal(validatePayload("a".repeat(MAX_SIGNAL_BYTES)).length, MAX_SIGNAL_BYTES);
  assert.throws(() => validatePayload("é".repeat(MAX_SIGNAL_BYTES)), ApiError);
  assert.deepEqual(await readBody(new Request("https://example.org/api", { method: "POST", body: '{"hello":true}' })), { hello: true });
  await assert.rejects(readBody(new Request("https://example.org/api", { method: "POST", body: "[1]" })), ApiError);
  await assert.rejects(readBody(new Request("https://example.org/api", { method: "POST", body: "a".repeat(MAX_BODY_BYTES + 1) })), ApiError);
  assert.throws(() => requireSameOrigin(new Request("https://example.org/api", { headers: { origin: "https://evil.example" } })), ApiError);
  assert.doesNotThrow(() => requireSameOrigin(new Request("https://example.org/api", { headers: { origin: "https://example.org" } })));
});
