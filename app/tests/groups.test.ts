import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GroupService, MAX_GROUP_MEMBERS } from "../lib/server/groups";
import { SessionService } from "../lib/server/sessions";
import { ApiError, IDLE_TTL_MS, INVITE_TTL_MS, sha256 } from "../lib/server/policy";

function database(onAll?: (sql: string, values: readonly (string | number | null)[], results: unknown[]) => Promise<void>) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
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
      async all<T>() {
        const results = sqlite.prepare(sql).all(...values) as T[];
        await onAll?.(sql, values, results);
        return { results, success: true };
      },
      async run() { return execute(); },
      execute,
    };
    return statement;
  };
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try { const output = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return output; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

const NOW = 1_700_000_000_000;
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;

async function group(service: GroupService) {
  const joinHash = await sha256("a randomly generated invitation secret remains in the URL fragment");
  const host = await service.create({ deviceName: "Laptop", sessionName: "Our files", joinHash }, "192.0.2.1");
  const first = await service.join(host.code, { deviceName: "Phone", joinHash }, "192.0.2.2");
  const second = await service.join(host.groupId, { deviceName: "Tablet", joinHash }, "192.0.2.3");
  return { host, first, second, joinHash };
}

async function approveAll(service: GroupService, participants: Awaited<ReturnType<typeof group>>) {
  for (const member of [participants.first, participants.second]) {
    await service.approve(participants.host.groupId, participants.host.token, { memberId: member.memberId, accept: true });
  }
}

test("group members require proof and host approval; pending clients receive no peer credentials", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new GroupService(db, NOW);
  const { host, first, second } = await group(service);
  assert.match(host.code, /^[a-f0-9]{6}$/);
  assert.equal(host.sessionName, "Our files");
  const pending = await service.poll(host.groupId, first.token);
  assert.equal(pending.memberStatus, "pending");
  assert.equal(pending.links.length, 0);
  assert.deepEqual(pending.members.map((member) => member.id), [first.memberId]);
  assert.equal((await service.poll(host.groupId, host.token)).members.length, 3);
  await assert.rejects(service.join(host.code, { deviceName: "Stranger", joinHash: "0".repeat(64) }, "192.0.2.8"), status(404));
  await assert.rejects(service.poll(host.groupId, "0".repeat(64)), status(401));
  await assert.rejects(service.approve(host.groupId, first.token, { memberId: second.memberId, accept: true }), status(403));
  const stored = sqlite.prepare("SELECT token_hash FROM group_members WHERE id = ?").get(first.memberId) as { token_hash: string };
  assert.equal(stored.token_hash, await sha256(first.token));
  assert.notEqual(stored.token_hash, first.token);
  await service.approve(host.groupId, host.token, { memberId: first.memberId, accept: false });
  const rejected = await service.poll(host.groupId, first.token);
  assert.equal(rejected.memberStatus, "rejected");
  assert.equal(rejected.links.length, 0);
});

test("three approved members get a full pair mesh with tokens visible only to their endpoint", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new GroupService(db, NOW);
  const participants = await group(service);
  await approveAll(service, participants);
  const { host, first, second } = participants;
  const hostPoll = await service.poll(host.groupId, host.token);
  const firstPoll = await service.poll(host.groupId, first.token);
  const secondPoll = await service.poll(host.groupId, second.token);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM group_links").get() as { count: number }).count, 3);
  assert.equal(hostPoll.links.length, 2);
  assert.equal(firstPoll.links.length, 2);
  assert.equal(secondPoll.links.length, 2);
  for (const member of hostPoll.members) assert.deepEqual(Object.keys(member).sort(), ["id", "name", "role", "status"]);
  const direct = firstPoll.links.find((link) => link.peerId === second.memberId)!;
  const reciprocal = secondPoll.links.find((link) => link.peerId === first.memberId)!;
  assert.equal(direct.sessionId, reciprocal.sessionId);
  assert.notEqual(direct.token, reciprocal.token);
  assert.notEqual(direct.role, reciprocal.role);
  assert.ok(!hostPoll.links.some((link) => link.sessionId === direct.sessionId));
  assert.ok(!JSON.stringify(hostPoll).includes(direct.token));
  assert.ok(!JSON.stringify(hostPoll).includes(reciprocal.token));
  const legacy = new SessionService(db, {}, NOW);
  assert.equal((await legacy.poll(direct.sessionId, direct.token, 0)).status, "approved");
  await assert.rejects(legacy.poll(direct.sessionId, host.token, 0), status(401));
  await legacy.signal(direct.sessionId, direct.token, "private encrypted guest to guest signaling");
  assert.equal((await legacy.poll(reciprocal.sessionId, reciprocal.token, 0)).signals[0].payload, "private encrypted guest to guest signaling");
  for (const link of hostPoll.links) assert.equal((await legacy.poll(link.sessionId, link.token, 0)).signals.length, 0);
});

test("overlapping approvals create one mutual pair and cannot duplicate member links", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new GroupService(db, NOW);
  const { host, first, second } = await group(service);
  await Promise.all([
    service.approve(host.groupId, host.token, { memberId: first.memberId, accept: true }),
    service.approve(host.groupId, host.token, { memberId: second.memberId, accept: true }),
  ]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM group_links").get() as { count: number }).count, 3);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, 3);
  const repeated = await Promise.allSettled([
    service.approve(host.groupId, host.token, { memberId: first.memberId, accept: true }),
    service.approve(host.groupId, host.token, { memberId: first.memberId, accept: true }),
  ]);
  assert.ok(repeated.every((result) => result.status === "rejected"));
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, 3);
});

test("approval reconciles a member who joins after its peer snapshot and is approved first", async (t) => {
  let delayedMemberId = "";
  let holdOnce = true;
  let releaseSnapshot!: () => void;
  let reportSnapshot!: () => void;
  const snapshotTaken = new Promise<void>((resolve) => { reportSnapshot = resolve; });
  const continueApproval = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const { db, sqlite } = database(async (sql, values, rows) => {
    if (holdOnce && sql.includes("id != ? AND status IN ('pending', 'approved')") && values[1] === delayedMemberId) {
      holdOnce = false;
      assert.equal(rows.length, 1, "the delayed approval initially sees only the host");
      reportSnapshot();
      await continueApproval;
    }
  });
  t.after(() => sqlite.close());
  const service = new GroupService(db, NOW);
  const joinHash = await sha256("interleaved invitation");
  const host = await service.create({ deviceName: "Host", joinHash }, "192.0.2.1");
  const first = await service.join(host.code, { deviceName: "First", joinHash }, "192.0.2.2");
  delayedMemberId = first.memberId;
  const delayedApproval = service.approve(host.groupId, host.token, { memberId: first.memberId, accept: true });
  await snapshotTaken;
  const second = await service.join(host.code, { deviceName: "Later arrival", joinHash }, "192.0.2.3");
  await service.approve(host.groupId, host.token, { memberId: second.memberId, accept: true });
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM group_links").get() as { count: number }).count, 1, "later arrival cannot yet connect to a pending member");
  releaseSnapshot();
  await delayedApproval;
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM group_links").get() as { count: number }).count, 3);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, 3);
  const firstPoll = await service.poll(host.groupId, first.token);
  const secondPoll = await service.poll(host.groupId, second.token);
  const direct = firstPoll.links.find((link) => link.peerId === second.memberId)!;
  const reciprocal = secondPoll.links.find((link) => link.peerId === first.memberId)!;
  assert.ok(direct, "late reconciliation creates the missing guest pair");
  assert.equal(direct.sessionId, reciprocal.sessionId);
  const legacy = new SessionService(db, {}, NOW);
  await legacy.signal(direct.sessionId, direct.token, "reconciled encrypted offer");
  assert.equal((await legacy.poll(reciprocal.sessionId, reciprocal.token, 0)).signals[0].payload, "reconciled encrypted offer");
});

for (const action of ["end", "leave"] as const) {
  test(`${action} during missing-link reconciliation cannot revive a closed connection`, async (t) => {
    let delayedMemberId = "";
    let snapshotReported = false;
    let missingReported = false;
    let releaseSnapshot!: () => void;
    let reportSnapshot!: () => void;
    let releaseMissing!: () => void;
    let reportMissing!: () => void;
    const snapshotTaken = new Promise<void>((resolve) => { reportSnapshot = resolve; });
    const continueApproval = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const missingTaken = new Promise<void>((resolve) => { reportMissing = resolve; });
    const continueReconciliation = new Promise<void>((resolve) => { releaseMissing = resolve; });
    const { db, sqlite } = database(async (sql, values, rows) => {
      if (values[1] !== delayedMemberId) return;
      if (!snapshotReported && sql.includes("id != ? AND status IN ('pending', 'approved')")) {
        snapshotReported = true; reportSnapshot(); await continueApproval;
      } else if (!missingReported && sql.startsWith("SELECT m.* FROM group_members m")) {
        assert.equal(rows.length, 1, "there is one late approved peer awaiting reconciliation");
        missingReported = true; reportMissing(); await continueReconciliation;
      }
    });
    t.after(() => sqlite.close());
    const service = new GroupService(db, NOW);
    const joinHash = await sha256(`closing while reconciling ${action}`);
    const host = await service.create({ deviceName: "Host", joinHash }, "192.0.2.1");
    const first = await service.join(host.code, { deviceName: "First", joinHash }, "192.0.2.2");
    delayedMemberId = first.memberId;
    const delayedApproval = service.approve(host.groupId, host.token, { memberId: first.memberId, accept: true });
    await snapshotTaken;
    const second = await service.join(host.code, { deviceName: "Later", joinHash }, "192.0.2.3");
    await service.approve(host.groupId, host.token, { memberId: second.memberId, accept: true });
    releaseSnapshot();
    await missingTaken;
    if (action === "end") await service.end(host.groupId, host.token);
    else await service.leave(host.groupId, second.token);
    releaseMissing();
    await delayedApproval;
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM group_links").get() as { count: number }).count, 2);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, 2, "no orphan child session is inserted");
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'approved'").get() as { count: number }).count, action === "end" ? 0 : 1);
    const firstPoll = await service.poll(host.groupId, first.token);
    assert.equal(firstPoll.links.length, action === "end" ? 0 : 1);
    assert.ok(!firstPoll.links.some((link) => link.peerId === second.memberId));
  });
}

test("capacity includes pending joins and concurrent joins cannot exceed the eight-member bound", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new GroupService(db, NOW);
  const { host, joinHash } = await group(service);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => service.join(host.code, { deviceName: `Extra ${index}`, joinHash }, `192.0.2.${index + 10}`)));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, MAX_GROUP_MEMBERS - 3);
  assert.equal((await service.poll(host.groupId, host.token)).members.length, MAX_GROUP_MEMBERS);
});

test("approving a full group concurrently creates exactly 28 authenticated pair sessions", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new GroupService(db, NOW);
  const joinHash = await sha256("full group invitation");
  const host = await service.create({ deviceName: "Host", joinHash }, "192.0.2.1");
  const guests = await Promise.all(Array.from({ length: 7 }, (_, index) => service.join(host.code, { deviceName: `Guest ${index}`, joinHash }, `192.0.2.${index + 2}`)));
  await Promise.all(guests.map((guest) => service.approve(host.groupId, host.token, { memberId: guest.memberId, accept: true })));
  const pairCount = MAX_GROUP_MEMBERS * (MAX_GROUP_MEMBERS - 1) / 2;
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM group_links").get() as { count: number }).count, pairCount);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, pairCount);
  const legacy = new SessionService(db, {}, NOW);
  for (const member of [host, ...guests]) {
    const poll = await service.poll(host.groupId, member.token);
    assert.equal(poll.links.length, MAX_GROUP_MEMBERS - 1);
    assert.equal(new Set(poll.links.map((link) => link.peerId)).size, MAX_GROUP_MEMBERS - 1);
    for (const link of poll.links) assert.equal((await legacy.poll(link.sessionId, link.token, 0)).status, "approved");
  }
  await service.leave(host.groupId, host.token);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'approved'").get() as { count: number }).count, 0);
  assert.equal((await service.poll(host.groupId, guests[0].token)).status, "closed");
});

test("guest leave closes only its pairs and host end closes all links and queued signaling", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new GroupService(db, NOW);
  const participants = await group(service); await approveAll(service, participants);
  const { host, first, second, joinHash } = participants;
  const legacy = new SessionService(db, {}, NOW);
  const firstPoll = await service.poll(host.groupId, first.token);
  const hostPoll = await service.poll(host.groupId, host.token);
  const remaining = hostPoll.links.find((link) => link.peerId === second.memberId)!;
  for (const link of firstPoll.links) await legacy.signal(link.sessionId, link.token, "queued ciphertext");
  await assert.rejects(service.end(host.groupId, first.token), status(403));
  await service.leave(host.groupId, first.token);
  assert.equal((await service.poll(host.groupId, first.token)).memberStatus, "left");
  assert.equal((await service.poll(host.groupId, first.token)).links.length, 0);
  assert.equal((await service.poll(host.groupId, host.token)).links.length, 1);
  for (const link of firstPoll.links) assert.equal((await legacy.poll(link.sessionId, link.token, 0)).status, "closed");
  assert.equal((await legacy.poll(remaining.sessionId, remaining.token, 0)).status, "approved");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM signals").get() as { count: number }).count, 0);
  await legacy.signal(remaining.sessionId, remaining.token, "remaining ciphertext");
  await service.end(host.groupId, host.token);
  assert.equal((await service.poll(host.groupId, second.token)).status, "closed");
  assert.equal((await service.poll(host.groupId, second.token)).links.length, 0);
  assert.equal((await legacy.poll(remaining.sessionId, remaining.token, 0)).status, "closed");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM signals").get() as { count: number }).count, 0);
  await assert.rejects(service.join(host.code, { deviceName: "Late", joinHash }, "192.0.2.20"), status(404));
  await assert.rejects(legacy.signal(remaining.sessionId, remaining.token, "late ciphertext"), status(409));
});

test("polls preserve active group and child lifetimes; abandoned groups are cleaned up", async (t) => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const service = new GroupService(db, NOW);
  const participants = await group(service); await approveAll(service, participants);
  const { host, first } = participants;
  const late = new GroupService(db, NOW + INVITE_TTL_MS + 1);
  const poll = await late.poll(host.groupId, first.token);
  assert.equal(poll.expiresAt, NOW + INVITE_TTL_MS + 1 + IDLE_TTL_MS);
  for (const link of poll.links) {
    const room = sqlite.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(link.sessionId) as { expires_at: number };
    assert.equal(room.expires_at, poll.expiresAt);
  }
  const expired = new GroupService(db, poll.expiresAt + 1);
  await assert.rejects(expired.poll(host.groupId, host.token), status(410));
  await expired.create({ deviceName: "Fresh", joinHash: await sha256("new secret") }, "192.0.2.30");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM group_rooms WHERE id = ?").get(host.groupId) as { count: number }).count, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM group_links").get() as { count: number }).count, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, 0);
});
