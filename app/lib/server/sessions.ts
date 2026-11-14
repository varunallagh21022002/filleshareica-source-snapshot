import {
  ApiError, IDLE_TTL_MS, INVITE_TTL_MS, MAX_QUEUED_SIGNALS, randomToken,
  sessionSlug, sha256, validateConnectionRevision, validateDeviceName, validateJoinHash, validatePayload, validateSessionId, validateSessionIdentifier, validateSessionName,
  type SessionRole, type SessionStatus,
} from "./policy";

export interface SessionEnvironment {
  ICE_SERVERS_JSON?: string;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
}

interface SessionRow {
  id: string;
  session_name: string | null;
  slug: string | null;
  connection_revision: number;
  join_hash: string;
  host_token_hash: string;
  guest_token_hash: string | null;
  host_name: string;
  guest_name: string | null;
  status: SessionStatus;
  created_at: number;
  expires_at: number;
  last_active_at: number;
  host_turn_json: string | null;
  guest_turn_json: string | null;
  host_turn_expires_at: number | null;
  guest_turn_expires_at: number | null;
}

interface AuthenticatedSession { row: SessionRow; role: SessionRole }
const STUN: RTCIceServer = { urls: "stun:stun.cloudflare.com:3478" };

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function iceServers(value: unknown): RTCIceServer[] {
  const items = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return items.filter((item): item is RTCIceServer => {
    if (!item || typeof item !== "object") return false;
    const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
    return urls.length > 0 && urls.every((url: unknown) => typeof url === "string" && /^(stun|stuns|turn|turns):[^\s]+$/.test(url));
  }).slice(0, 8);
}

function hasRelay(servers: RTCIceServer[]): boolean {
  return servers.some((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/.test(url)));
}

export class SessionService {
  constructor(
    private db: D1Database,
    private environment: SessionEnvironment = {},
    private now = Date.now(),
    private fetcher: typeof fetch = fetch,
  ) {}

  private async cleanup(): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM signals WHERE session_id IN (SELECT id FROM sessions WHERE expires_at <= ?)").bind(this.now),
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(this.now),
      this.db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(this.now),
    ]);
  }

  private async rateLimit(key: string, limit: number, windowMs: number): Promise<void> {
    const window = Math.floor(this.now / windowMs);
    const expiresAt = (window + 1) * windowMs;
    const row = await this.db.prepare(
      "INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count",
    ).bind(`${key}:${window}`, expiresAt).first<{ count: number }>();
    if (!row || row.count > limit) throw new ApiError(429, "Too many requests. Please wait and try again.", Math.max(1, Math.ceil((expiresAt - this.now) / 1000)));
  }

  async create(body: Record<string, unknown>, address: string) {
    const deviceName = validateDeviceName(body.deviceName);
    const sessionName = validateSessionName(body.sessionName);
    const joinHash = validateJoinHash(body.joinHash);
    await this.cleanup();
    await this.rateLimit(`create:${await sha256(address)}`, 12, 10 * 60_000);
    const sessionId = crypto.randomUUID();
    const token = randomToken();
    const expiresAt = this.now + INVITE_TTL_MS;
    const tokenHash = await sha256(token);
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = sessionSlug(sessionName);
      const inserted = await this.db.prepare(
        "INSERT INTO sessions (id, session_name, slug, join_hash, host_token_hash, host_name, status, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?) ON CONFLICT(slug) DO NOTHING RETURNING id",
      ).bind(sessionId, sessionName, slug, joinHash, tokenHash, deviceName, this.now, expiresAt, this.now).first();
      if (inserted) return { sessionId, token, role: "host" as const, expiresAt, slug, sessionName, connectionRevision: 0 };
    }
    throw new ApiError(503, "A connection link could not be created. Please try again.");
  }

  async join(sessionId: string, body: Record<string, unknown>, address: string) {
    validateSessionIdentifier(sessionId);
    const deviceName = validateDeviceName(body.deviceName);
    const joinHash = validateJoinHash(body.joinHash);
    await this.rateLimit(`join:${await sha256(address)}`, 30, 10 * 60_000);
    const token = randomToken();
    // Conditional UPDATE claims the only guest slot atomically, including when
    // several requests carrying the same invitation arrive together.
    const row = await this.db.prepare(
      "UPDATE sessions SET guest_token_hash = ?, guest_name = ?, status = 'pending', last_active_at = ?, expires_at = ? WHERE (id = ? OR slug = ?) AND join_hash = ? AND status = 'waiting' AND guest_token_hash IS NULL AND expires_at > ? RETURNING id, expires_at, slug, session_name, connection_revision",
    ).bind(await sha256(token), deviceName, this.now, this.now + IDLE_TTL_MS, sessionId, sessionId, joinHash, this.now).first<SessionRow>();
    if (!row) throw new ApiError(404, "This connection link is unavailable, already in use, or expired.");
    return { sessionId: row.id, token, role: "guest" as const, expiresAt: row.expires_at, slug: row.slug, sessionName: row.session_name, connectionRevision: row.connection_revision };
  }

  private async authenticate(sessionId: string, token: string | null): Promise<AuthenticatedSession> {
    validateSessionId(sessionId);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, "This connection is not authorized.");
    const row = await this.db.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first<SessionRow>();
    const hash = await sha256(token);
    if (!row || (!constantTimeEqual(row.host_token_hash, hash) && !constantTimeEqual(row.guest_token_hash ?? "", hash))) {
      throw new ApiError(401, "This connection is not authorized.");
    }
    if (row.expires_at <= this.now) throw new ApiError(410, "This connection has expired. Create a new link to reconnect.");
    return { row, role: constantTimeEqual(row.host_token_hash, hash) ? "host" : "guest" };
  }

  private async touch(id: string): Promise<number> {
    const row = await this.db.prepare(
      "UPDATE sessions SET last_active_at = ?, expires_at = ? WHERE id = ? AND status IN ('waiting', 'pending', 'approved') AND expires_at > ? RETURNING expires_at",
    ).bind(this.now, this.now + IDLE_TTL_MS, id, this.now).first<{ expires_at: number }>();
    return row?.expires_at ?? this.now;
  }

  private async getIce(row: SessionRow, role: SessionRole): Promise<{ iceServers: RTCIceServer[]; relayAvailable: boolean }> {
    const baseline = [STUN];
    if (this.environment.ICE_SERVERS_JSON) {
      try {
        const configured = iceServers(JSON.parse(this.environment.ICE_SERVERS_JSON));
        if (configured.length) return { iceServers: [...baseline, ...configured], relayAvailable: hasRelay(configured) };
      } catch { /* A bad optional setting must not prevent direct transfers. */ }
    }
    if (!this.environment.CLOUDFLARE_TURN_KEY_ID || !this.environment.CLOUDFLARE_TURN_API_TOKEN) {
      return { iceServers: baseline, relayAvailable: false };
    }
    const cached = role === "host" ? row.host_turn_json : row.guest_turn_json;
    const expires = role === "host" ? row.host_turn_expires_at : row.guest_turn_expires_at;
    if (cached && expires && expires > this.now + 300_000) {
      try {
        const servers = iceServers(JSON.parse(cached));
        return { iceServers: [...baseline, ...servers], relayAvailable: hasRelay(servers) };
      } catch { /* Regenerate a malformed cached credential. */ }
    }
    try {
      const response = await this.fetcher(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.environment.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.environment.CLOUDFLARE_TURN_API_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: 3600 }),
          signal: AbortSignal.timeout(7000),
        },
      );
      if (!response.ok) throw new Error("TURN credentials are unavailable");
      const result = await response.json() as { iceServers?: unknown };
      const servers = iceServers(result.iceServers);
      if (!servers.length) throw new Error("TURN credentials are invalid");
      // Column names are selected only from this fixed role union.
      await this.db.prepare(
        `UPDATE sessions SET ${role}_turn_json = ?, ${role}_turn_expires_at = ? WHERE id = ?`,
      ).bind(JSON.stringify(servers), this.now + 3600_000, row.id).run();
      return { iceServers: [...baseline, ...servers], relayAvailable: hasRelay(servers) };
    } catch {
      // Back off a failed optional provider instead of retrying every poll.
      await this.db.prepare(
        `UPDATE sessions SET ${role}_turn_json = '[]', ${role}_turn_expires_at = ? WHERE id = ?`,
      ).bind(this.now + 600_000, row.id).run();
      return { iceServers: baseline, relayAvailable: false };
    }
  }

  async poll(sessionId: string, token: string | null, after: number) {
    const { row, role } = await this.authenticate(sessionId, token);
    await this.rateLimit(`poll:${sessionId}:${role}`, 180, 60_000);
    const expiresAt = ["waiting", "pending", "approved"].includes(row.status) ? await this.touch(sessionId) : row.expires_at;
    // The cursor acknowledges delivery to this recipient only. No participant
    // can delete the peer's queue or read their own outbound messages.
    await this.db.prepare("DELETE FROM signals WHERE session_id = ? AND target_role = ? AND id <= ?").bind(sessionId, role, after).run();
    const messages = row.status === "approved"
      ? await this.db.prepare("SELECT id, payload FROM signals WHERE session_id = ? AND target_role = ? AND connection_revision = ? AND id > ? ORDER BY id ASC LIMIT 64").bind(sessionId, role, row.connection_revision, after).all<{ id: number; payload: string }>()
      : { results: [] };
    const ice = row.status === "approved" ? await this.getIce(row, role) : { iceServers: [STUN], relayAvailable: false };
    return {
      status: row.status, role,
      sessionId: row.id, slug: row.slug, sessionName: row.session_name, connectionRevision: row.connection_revision,
      peerName: role === "host" ? row.guest_name : row.host_name,
      expiresAt, signals: messages.results, ...ice,
    };
  }

  async resume(sessionId: string, token: string | null) {
    const { role, row } = await this.authenticate(sessionId, token);
    if (!["waiting", "pending", "approved"].includes(row.status)) throw new ApiError(409, "This connection is closed. Create a new link to reconnect.");
    await this.rateLimit(`resume:${sessionId}:${role}`, 30, 60_000);
    // D1 batches execute as a transaction: revision and queue reset are observed
    // together. Concurrent refreshes each receive their own incremented revision.
    const [updated] = await this.db.batch<SessionRow>([
      this.db.prepare("UPDATE sessions SET connection_revision = connection_revision + 1, last_active_at = ?, expires_at = ? WHERE id = ? AND status IN ('waiting', 'pending', 'approved') AND expires_at > ? RETURNING id, slug, session_name, status, connection_revision, expires_at")
        .bind(this.now, this.now + IDLE_TTL_MS, sessionId, this.now),
      this.db.prepare("DELETE FROM signals WHERE session_id = ?").bind(sessionId),
    ]);
    const current = updated.results[0];
    if (!current) throw new ApiError(409, "This connection is no longer available.");
    return { sessionId: current.id, slug: current.slug, sessionName: current.session_name, status: current.status, connectionRevision: current.connection_revision, expiresAt: current.expires_at, role };
  }

  async approve(sessionId: string, token: string | null, accept: unknown) {
    const { role, row } = await this.authenticate(sessionId, token);
    if (role !== "host") throw new ApiError(403, "Only the device that created the link can approve a connection.");
    if (typeof accept !== "boolean") throw new ApiError(400, "Choose whether to approve this device.");
    if (row.status !== "pending") throw new ApiError(409, "There is no device waiting for approval.");
    const status = accept ? "approved" : "rejected";
    const changed = await this.db.prepare(
      "UPDATE sessions SET status = ?, last_active_at = ?, expires_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id",
    ).bind(status, this.now, this.now + IDLE_TTL_MS, sessionId, this.now).first();
    if (!changed) throw new ApiError(409, "This connection is no longer waiting for approval.");
    return { status };
  }

  async signal(sessionId: string, token: string | null, value: unknown, revisionValue?: unknown) {
    const { role, row } = await this.authenticate(sessionId, token);
    if (row.status !== "approved") throw new ApiError(409, "Approve the connection before exchanging messages.");
    const payload = validatePayload(value);
    const connectionRevision = validateConnectionRevision(revisionValue) ?? row.connection_revision;
    if (connectionRevision !== row.connection_revision) throw new ApiError(409, "The connection restarted. Wait for reconnection and try again.");
    await this.rateLimit(`signal:${sessionId}:${role}`, 180, 60_000);
    const target = role === "host" ? "guest" : "host";
    const inserted = await this.db.prepare(
      "INSERT INTO signals (session_id, target_role, payload, connection_revision, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND status = 'approved' AND connection_revision = ? AND expires_at > ?) AND (SELECT COUNT(*) FROM signals WHERE session_id = ? AND target_role = ?) < ? RETURNING id",
    ).bind(sessionId, target, payload, connectionRevision, this.now, sessionId, connectionRevision, this.now, sessionId, target, MAX_QUEUED_SIGNALS).first<{ id: number }>();
    if (!inserted) throw new ApiError(409, "The connection is closed or its signaling queue is full. Reconnect and try again.");
    await this.touch(sessionId);
    return { id: inserted.id };
  }

  async leave(sessionId: string, token: string | null) {
    await this.authenticate(sessionId, token);
    await this.db.batch([
      this.db.prepare("UPDATE sessions SET status = 'closed', last_active_at = ?, expires_at = MIN(expires_at, ?) WHERE id = ?").bind(this.now, this.now + 60_000, sessionId),
      this.db.prepare("DELETE FROM signals WHERE session_id = ?").bind(sessionId),
    ]);
    return { status: "closed" as const };
  }
}
