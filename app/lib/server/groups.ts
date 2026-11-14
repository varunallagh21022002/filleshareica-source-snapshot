import {
  ApiError, IDLE_TTL_MS, INVITE_TTL_MS, randomToken, sha256,
  validateDeviceName, validateJoinHash, validateSessionId, validateSessionName,
} from "./policy";

export const MAX_GROUP_MEMBERS = 8;
const MAX_GROUP_MEMBER_RECORDS = 32;
type GroupRole = "host" | "guest";
type MemberStatus = "pending" | "approved" | "left" | "rejected";
interface GroupRow {
  id: string; code: string; session_name: string | null; join_hash: string;
  status: "open" | "closed"; created_at: number; expires_at: number; last_active_at: number;
}
interface MemberRow {
  id: string; room_id: string; token_hash: string; name: string;
  role: GroupRole; status: MemberStatus; created_at: number; last_active_at: number;
}
interface LinkRow {
  session_id: string; room_id: string; host_member_id: string; guest_member_id: string;
  host_token: string; guest_token: string; host_name: string; guest_name: string;
}

function validateGroupIdentifier(value: string): void {
  if (/^[a-f0-9]{6}$/.test(value)) return;
  validateSessionId(value);
}

export class GroupService {
  constructor(private db: D1Database, private now = Date.now()) {}

  private async rateLimit(key: string, limit: number, windowMs: number): Promise<void> {
    const window = Math.floor(this.now / windowMs);
    const expiresAt = (window + 1) * windowMs;
    const row = await this.db.prepare(
      "INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count",
    ).bind(`group:${key}:${window}`, expiresAt).first<{ count: number }>();
    if (!row || row.count > limit) throw new ApiError(429, "Too many requests. Please wait and try again.", Math.max(1, Math.ceil((expiresAt - this.now) / 1000)));
  }

  private async cleanup(): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM signals WHERE session_id IN (SELECT session_id FROM group_links WHERE room_id IN (SELECT id FROM group_rooms WHERE expires_at <= ?))").bind(this.now),
      this.db.prepare("DELETE FROM sessions WHERE id IN (SELECT session_id FROM group_links WHERE room_id IN (SELECT id FROM group_rooms WHERE expires_at <= ?))").bind(this.now),
      this.db.prepare("DELETE FROM group_rooms WHERE expires_at <= ?").bind(this.now),
      this.db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(this.now),
    ]);
  }

  async create(body: Record<string, unknown>, address: string) {
    const name = validateDeviceName(body.deviceName);
    const sessionName = validateSessionName(body.sessionName);
    const joinHash = validateJoinHash(body.joinHash);
    await this.cleanup();
    await this.rateLimit(`create:${await sha256(address)}`, 12, 10 * 60_000);
    const groupId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const token = randomToken();
    const tokenHash = await sha256(token);
    const expiresAt = this.now + INVITE_TTL_MS;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomToken().slice(0, 6);
      const [room] = await this.db.batch<{ id: string }>([
        this.db.prepare("INSERT INTO group_rooms (id, code, session_name, join_hash, status, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT(code) DO NOTHING RETURNING id")
          .bind(groupId, code, sessionName, joinHash, this.now, expiresAt, this.now),
        this.db.prepare("INSERT INTO group_members (id, room_id, token_hash, name, role, status, created_at, last_active_at) SELECT ?, ?, ?, ?, 'host', 'approved', ?, ? WHERE EXISTS (SELECT 1 FROM group_rooms WHERE id = ?)")
          .bind(memberId, groupId, tokenHash, name, this.now, this.now, groupId),
      ]);
      if (room.results.length) return { groupId, code, sessionName, memberId, token, role: "host" as const, expiresAt };
    }
    throw new ApiError(503, "A group link could not be created. Please try again.");
  }

  async join(identifier: string, body: Record<string, unknown>, address: string) {
    validateGroupIdentifier(identifier);
    const name = validateDeviceName(body.deviceName);
    const joinHash = validateJoinHash(body.joinHash);
    await this.rateLimit(`join:${await sha256(address)}`, 30, 10 * 60_000);
    const memberId = crypto.randomUUID();
    const token = randomToken();
    // The room proof, available slot, and pending insertion are one statement.
    const member = await this.db.prepare(
      "INSERT INTO group_members (id, room_id, token_hash, name, role, status, created_at, last_active_at) SELECT ?, r.id, ?, ?, 'guest', 'pending', ?, ? FROM group_rooms r WHERE (r.id = ? OR r.code = ?) AND r.join_hash = ? AND r.status = 'open' AND r.expires_at > ? AND (SELECT COUNT(*) FROM group_members m WHERE m.room_id = r.id AND m.status IN ('pending', 'approved')) < ? AND (SELECT COUNT(*) FROM group_members m WHERE m.room_id = r.id) < ? RETURNING room_id",
    ).bind(memberId, await sha256(token), name, this.now, this.now, identifier, identifier, joinHash, this.now, MAX_GROUP_MEMBERS, MAX_GROUP_MEMBER_RECORDS).first<{ room_id: string }>();
    if (!member) throw new ApiError(404, "This group link is unavailable, expired, or full. Ask the host for a new invitation.");
    const room = await this.db.prepare("SELECT * FROM group_rooms WHERE id = ?").bind(member.room_id).first<GroupRow>();
    if (!room) throw new ApiError(404, "This group is no longer available.");
    return { groupId: room.id, code: room.code, sessionName: room.session_name, memberId, token, role: "guest" as const, expiresAt: room.expires_at };
  }

  private async authenticate(groupId: string, token: string | null): Promise<{ room: GroupRow; member: MemberRow }> {
    validateSessionId(groupId);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, "This group is not authorized.");
    const member = await this.db.prepare("SELECT * FROM group_members WHERE room_id = ? AND token_hash = ?").bind(groupId, await sha256(token)).first<MemberRow>();
    const room = member ? await this.db.prepare("SELECT * FROM group_rooms WHERE id = ?").bind(groupId).first<GroupRow>() : null;
    if (!member || !room) throw new ApiError(401, "This group is not authorized.");
    if (room.expires_at <= this.now) throw new ApiError(410, "This group has expired. Create a new group to reconnect.");
    return { room, member };
  }

  private async touch(groupId: string, memberId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE group_rooms SET last_active_at = ?, expires_at = ? WHERE id = ? AND status = 'open' AND expires_at > ?").bind(this.now, this.now + IDLE_TTL_MS, groupId, this.now),
      this.db.prepare("UPDATE group_members SET last_active_at = ? WHERE id = ? AND status IN ('pending', 'approved')").bind(this.now, memberId),
      // Healthy child connections no longer poll independently. Renew their
      // leases together, at most once per ten minutes, instead of writing all
      // 28 mesh links on every roster read.
      this.db.prepare("UPDATE sessions SET last_active_at = ?, expires_at = ? WHERE id IN (SELECT session_id FROM group_links WHERE room_id = ?) AND status = 'approved' AND expires_at > ? AND expires_at <= ?").bind(this.now, this.now + IDLE_TTL_MS, groupId, this.now, this.now + IDLE_TTL_MS - 10 * 60_000),
    ]);
  }

  async poll(groupId: string, token: string | null) {
    const { room, member } = await this.authenticate(groupId, token);
    await this.rateLimit(`poll:${groupId}:${member.id}`, 180, 60_000);
    const isActive = room.status === "open" && ["pending", "approved"].includes(member.status);
    if (isActive) await this.touch(groupId, member.id);
    const members = await this.db.prepare(
      member.role === "host"
        ? "SELECT * FROM group_members WHERE room_id = ? ORDER BY created_at, id"
        : member.status === "approved"
          ? "SELECT * FROM group_members WHERE room_id = ? AND (status = 'approved' OR id = ?) ORDER BY created_at, id"
          : "SELECT * FROM group_members WHERE room_id = ? AND id = ? ORDER BY created_at, id",
    ).bind(...(member.role === "host" ? [groupId] : [groupId, member.id])).all<MemberRow>();
    const links = room.status === "open" && member.status === "approved"
      ? await this.db.prepare(
        "SELECT l.*, h.name AS host_name, g.name AS guest_name FROM group_links l JOIN group_members h ON h.id = l.host_member_id JOIN group_members g ON g.id = l.guest_member_id JOIN sessions s ON s.id = l.session_id WHERE l.room_id = ? AND (l.host_member_id = ? OR l.guest_member_id = ?) AND h.status = 'approved' AND g.status = 'approved' AND s.status = 'approved' AND s.expires_at > ?",
      ).bind(groupId, member.id, member.id, this.now).all<LinkRow>()
      : { results: [] as LinkRow[] };
    return {
      groupId, code: room.code, sessionName: room.session_name, status: room.status,
      memberId: member.id, role: member.role, memberStatus: member.status,
      expiresAt: isActive ? this.now + IDLE_TTL_MS : room.expires_at, maxMembers: MAX_GROUP_MEMBERS,
      members: members.results.map((item) => ({ id: item.id, name: item.name, role: item.role, status: item.status })),
      links: links.results.map((link) => {
        const host = link.host_member_id === member.id;
        return { peerId: host ? link.guest_member_id : link.host_member_id, peerName: host ? link.guest_name : link.host_name, sessionId: link.session_id, token: host ? link.host_token : link.guest_token, role: host ? "host" as const : "guest" as const };
      }),
    };
  }

  async approve(groupId: string, token: string | null, body: Record<string, unknown>) {
    const { room, member: actor } = await this.authenticate(groupId, token);
    if (actor.role !== "host" || actor.status !== "approved") throw new ApiError(403, "Only the group host can approve participants.");
    if (room.status !== "open") throw new ApiError(409, "This group has ended.");
    const targetId = typeof body.memberId === "string" ? body.memberId : "";
    validateSessionId(targetId);
    if (typeof body.accept !== "boolean") throw new ApiError(400, "Choose whether to approve this participant.");
    await this.rateLimit(`approve:${groupId}`, 60, 60_000);
    const target = await this.db.prepare("SELECT * FROM group_members WHERE room_id = ? AND id = ? AND role = 'guest' AND status = 'pending'").bind(groupId, targetId).first<MemberRow>();
    if (!target) throw new ApiError(409, "This participant is no longer waiting for approval.");
    if (!body.accept) {
      const changed = await this.db.prepare("UPDATE group_members SET status = 'rejected', last_active_at = ? WHERE room_id = ? AND id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM group_rooms WHERE id = ? AND status = 'open' AND expires_at > ?) RETURNING id").bind(this.now, groupId, targetId, groupId, this.now).first();
      if (!changed) throw new ApiError(409, "This participant is no longer waiting for approval.");
      return { status: "rejected" as const, memberId: targetId };
    }
    // Include pending peers before the transaction so overlapping approvals can
    // establish their mutual links in the same transaction as approval.
    const peers = await this.db.prepare("SELECT * FROM group_members WHERE room_id = ? AND id != ? AND status IN ('pending', 'approved')").bind(groupId, targetId).all<MemberRow>();
    const statements: D1PreparedStatement[] = [
      this.db.prepare("UPDATE group_members SET status = 'approved', last_active_at = ? WHERE room_id = ? AND id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM group_rooms WHERE id = ? AND status = 'open' AND expires_at > ?) RETURNING id").bind(this.now, groupId, targetId, groupId, this.now),
      ...await this.linkStatements(room, target, peers.results),
    ];
    const [changed] = await this.db.batch<{ id: string }>(statements);
    if (!changed.results.length) throw new ApiError(409, "This participant is no longer waiting for approval.");

    // A participant may join after the initial peer snapshot and finish approval
    // before this batch. Re-read after approval commits: for each approved pair,
    // the later approval's reconciliation now sees the earlier approved member.
    // Guarded transactional inserts also tolerate concurrent reconciliation and
    // a room ending or either member leaving between this read and the batch.
    const missing = await this.db.prepare(
      "SELECT m.* FROM group_members m WHERE m.room_id = ? AND m.id != ? AND m.status = 'approved' AND NOT EXISTS (SELECT 1 FROM group_links l WHERE l.room_id = m.room_id AND ((l.host_member_id = ? AND l.guest_member_id = m.id) OR (l.guest_member_id = ? AND l.host_member_id = m.id)))",
    ).bind(groupId, targetId, targetId, targetId).all<MemberRow>();
    if (missing.results.length) await this.db.batch(await this.linkStatements(room, target, missing.results));
    await this.touch(groupId, actor.id);
    return { status: "approved" as const, memberId: targetId };
  }

  private async linkStatements(room: GroupRow, target: MemberRow, peers: MemberRow[]): Promise<D1PreparedStatement[]> {
    const groupId = room.id;
    const statements: D1PreparedStatement[] = [];
    for (const peer of peers) {
      const [host, guest] = target.id < peer.id ? [target, peer] : [peer, target];
      const sessionId = crypto.randomUUID();
      const hostToken = randomToken();
      const guestToken = randomToken();
      statements.push(
        this.db.prepare(
          "INSERT INTO sessions (id, session_name, join_hash, host_token_hash, guest_token_hash, host_name, guest_name, status, created_at, expires_at, last_active_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ? WHERE EXISTS (SELECT 1 FROM group_rooms WHERE id = ? AND status = 'open' AND expires_at > ?) AND (SELECT COUNT(*) FROM group_members WHERE room_id = ? AND id IN (?, ?) AND status = 'approved') = 2 AND NOT EXISTS (SELECT 1 FROM group_links WHERE room_id = ? AND host_member_id = ? AND guest_member_id = ?)",
        ).bind(sessionId, room.session_name, room.join_hash, await sha256(hostToken), await sha256(guestToken), host.name, guest.name, this.now, this.now + IDLE_TTL_MS, this.now, groupId, this.now, groupId, host.id, guest.id, groupId, host.id, guest.id),
        this.db.prepare("INSERT INTO group_links (session_id, room_id, host_member_id, guest_member_id, host_token, guest_token, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)").bind(sessionId, groupId, host.id, guest.id, hostToken, guestToken, this.now, sessionId),
      );
    }
    return statements;
  }

  private async close(groupId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE group_rooms SET status = 'closed', last_active_at = ?, expires_at = MIN(expires_at, ?) WHERE id = ?").bind(this.now, this.now + 60_000, groupId),
      this.db.prepare("UPDATE sessions SET status = 'closed', last_active_at = ?, expires_at = MIN(expires_at, ?) WHERE id IN (SELECT session_id FROM group_links WHERE room_id = ?)").bind(this.now, this.now + 60_000, groupId),
      this.db.prepare("DELETE FROM signals WHERE session_id IN (SELECT session_id FROM group_links WHERE room_id = ?)").bind(groupId),
    ]);
  }

  async leave(groupId: string, token: string | null) {
    const { member } = await this.authenticate(groupId, token);
    if (member.role === "host") { await this.close(groupId); return { status: "closed" as const }; }
    await this.db.batch([
      this.db.prepare("UPDATE group_members SET status = 'left', last_active_at = ? WHERE room_id = ? AND id = ?").bind(this.now, groupId, member.id),
      this.db.prepare("UPDATE sessions SET status = 'closed', last_active_at = ?, expires_at = MIN(expires_at, ?) WHERE id IN (SELECT session_id FROM group_links WHERE room_id = ? AND (host_member_id = ? OR guest_member_id = ?))").bind(this.now, this.now + 60_000, groupId, member.id, member.id),
      this.db.prepare("DELETE FROM signals WHERE session_id IN (SELECT session_id FROM group_links WHERE room_id = ? AND (host_member_id = ? OR guest_member_id = ?))").bind(groupId, member.id, member.id),
    ]);
    return { status: "left" as const };
  }

  async end(groupId: string, token: string | null) {
    const { member } = await this.authenticate(groupId, token);
    if (member.role !== "host" || member.status !== "approved") throw new ApiError(403, "Only the group host can end the session for everyone.");
    await this.close(groupId);
    return { status: "closed" as const };
  }
}
