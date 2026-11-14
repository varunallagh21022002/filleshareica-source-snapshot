import type { DeviceIdentity } from "../market/types";
import { digestSendManifest, offlineEventText, type OfflineSendEvent, type PreparedSend, type SendAccessSummary, type SendDecisionKind, type SendIntent, type SendPermit } from "../market/send-types";
import { ApiError, sha256 } from "./policy";
import { signMarketPayload, thumbprint, unbase64url } from "./market-crypto";
import { MAX_BATCH_FILES, isValidFileSize } from "../transfer-policy";

const PERMIT_MS = 10 * 60_000;
const encoder = new TextEncoder();
type Purpose = "credit" | "catchup" | "send";
interface OperationRow { id: string; installation_id: string; operation_id: string; session_id: string; manifest_digest: string; intent_json: string | null; intent_hash: string | null; decision: SendDecisionKind | null; credit_id: string | null; status: "prepared" | "verified" | "released"; authorized_at: number | null; }
interface CreditRow { id: string; installation_id: string; status: string; operation_id: string | null; }
interface AttemptRow { id: string; installation_id: string; purpose: Purpose | null; operation_id: string | null; completed_at: number | null; ready_at: number; expires_at: number; }
export class SendPolicyError extends ApiError { constructor(status: number, message: string, public code: string) { super(status, message); } }
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** A sender-only ledger. It receives opaque IDs/sizes, never files, names or chat. */
export class SendMarketService {
  constructor(private db: D1Database, private device: DeviceIdentity, private env: { MARKET_SIGNING_JWK?: string; MARKET_ISSUER?: string }, private now: number, private premium: boolean, private development: boolean) {}
  private key(operationId: string): string { return `${this.device.installationId}:${operationId}`; }
  private async init(): Promise<void> {
    const upsert = this.premium ? "ON CONFLICT(installation_id) DO UPDATE SET premium_cutoff=MAX(premium_cutoff,excluded.premium_cutoff)" : "ON CONFLICT(installation_id) DO NOTHING";
    await this.db.prepare(`INSERT INTO market_send_states (installation_id,premium_cutoff) VALUES (?,?) ${upsert}`).bind(this.device.installationId, this.premium ? this.now : 0).run();
    if (this.premium) await this.db.prepare("UPDATE market_offline_sends SET status='cleared',settled_at=? WHERE installation_id=? AND status='pending'").bind(this.now, this.device.installationId).run();
  }
  async summary(): Promise<SendAccessSummary> {
    await this.init();
    const ready = await this.db.prepare("SELECT * FROM market_send_credits WHERE installation_id=? AND status='ready' LIMIT 1").bind(this.device.installationId).first<CreditRow>();
    const pending = await this.db.prepare("SELECT operation_id,COUNT(*) OVER() AS total FROM market_offline_sends WHERE installation_id=? AND status='pending' ORDER BY verified_at,id LIMIT 1000").bind(this.device.installationId).all<{ operation_id: string; total: number }>();
    const total = pending.results[0]?.total || 0;
    let credit: SendAccessSummary["credit"] = null;
    if (ready) {
      const proof = await signMarketPayload({ iss: this.env.MARKET_ISSUER || "fileshareica", v: 2, purpose: "credit", creditId: ready.id, installationId: this.device.installationId, keyThumbprint: await thumbprint(this.device.publicKey), iat: Math.floor(this.now / 1000) }, this.env.MARKET_SIGNING_JWK);
      if (proof) credit = { id: ready.id, proof };
    }
    return { policyVersion: 2, creditAvailable: Boolean(ready && credit), credit, pendingOfflineAds: total, pendingOperationIds: pending.results.map(row => row.operation_id), pendingOperationIdsComplete: total <= 1000, strictCatchUp: this.development };
  }
  private async operation(operationId: unknown): Promise<OperationRow> {
    if (!opaque(operationId)) throw new SendPolicyError(400, "Use a valid send operation reference.", "INVALID_OPERATION");
    const row = await this.db.prepare("SELECT * FROM market_send_operations WHERE id=? AND installation_id=?").bind(this.key(operationId), this.device.installationId).first<OperationRow>();
    if (!row) throw new SendPolicyError(404, "Prepare this send before continuing.", "SEND_NOT_FOUND"); return row;
  }
  private async intent(value: unknown): Promise<SendIntent> {
    const v = record(value);
    if (!exact(v, ["operationId", "sessionId", "manifestDigest", "files", "recipientIds", "retryOf"]) || !opaque(v.operationId) || !opaque(v.sessionId) || typeof v.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(v.manifestDigest)
      || !Array.isArray(v.files) || !v.files.length || v.files.length > MAX_BATCH_FILES || !Array.isArray(v.recipientIds) || !v.recipientIds.length || v.recipientIds.length > 8 || !v.recipientIds.every(opaque)
      || new Set(v.recipientIds).size !== v.recipientIds.length || (v.retryOf !== undefined && v.retryOf !== v.operationId)) throw new SendPolicyError(400, "Send one immutable batch with opaque file and recipient references.", "INVALID_SEND_INTENT");
    let total = 0;
    for (const item of v.files) {
      const file = record(item);
      if (!exact(file, ["id", "size"]) || !opaque(file.id) || !isValidFileSize(file.size)) throw new SendPolicyError(400, "Only opaque file IDs and valid sizes up to 100 GB may enter send accounting.", "INVALID_SEND_INTENT");
      total += Number(file.size); if (!Number.isSafeInteger(total)) throw new SendPolicyError(400, "This batch size is unsupported.", "INVALID_SEND_INTENT");
    }
    if (new Set(v.files.map(item => record(item).id)).size !== v.files.length) throw new SendPolicyError(400, "Each file reference must be unique.", "INVALID_SEND_INTENT");
    const intent = { operationId: v.operationId, sessionId: v.sessionId, manifestDigest: v.manifestDigest, files: v.files.map(item => ({ id: String(record(item).id), size: Number(record(item).size) })), recipientIds: [...v.recipientIds as string[]].sort() };
    if (await digestSendManifest(intent) !== intent.manifestDigest) throw new SendPolicyError(409, "The batch manifest changed. Create a new send operation.", "MANIFEST_MISMATCH");
    return intent;
  }
  async prepare(value: unknown): Promise<PreparedSend> {
    await this.init(); const intent = await this.intent(value); const id = this.key(intent.operationId);
    const text = JSON.stringify(intent); const hash = await sha256(text);
    const row = await this.db.prepare("INSERT INTO market_send_operations (id,installation_id,operation_id,session_id,manifest_digest,intent_json,intent_hash,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET intent_json=COALESCE(intent_json,excluded.intent_json),intent_hash=COALESCE(intent_hash,excluded.intent_hash) WHERE session_id=excluded.session_id AND manifest_digest=excluded.manifest_digest AND (intent_hash IS NULL OR intent_hash=excluded.intent_hash) RETURNING *")
      .bind(id, this.device.installationId, intent.operationId, intent.sessionId, intent.manifestDigest, text, hash, this.now).first<OperationRow>();
    if (!row) throw new SendPolicyError(409, "This operation already belongs to a different immutable batch.", "OPERATION_REPLAY");
    if (!row.decision && this.premium) await this.db.prepare("UPDATE market_send_operations SET decision='premium' WHERE id=? AND decision IS NULL").bind(id).run();
    if (!row.decision && !this.development && !this.premium) await this.db.prepare("UPDATE market_send_operations SET decision='no_fill' WHERE id=? AND decision IS NULL").bind(id).run();
    if (!row.decision && this.development && !this.premium) await this.db.batch([
      this.db.prepare("UPDATE market_send_credits SET status='reserved',operation_id=? WHERE id=(SELECT id FROM market_send_credits WHERE installation_id=? AND status='ready' LIMIT 1) AND EXISTS (SELECT 1 FROM market_send_operations WHERE id=? AND decision IS NULL)")
        .bind(intent.operationId, this.device.installationId, id),
      this.db.prepare("UPDATE market_send_operations SET decision='credit',credit_id=(SELECT id FROM market_send_credits WHERE installation_id=? AND status='reserved' AND operation_id=? LIMIT 1) WHERE id=? AND decision IS NULL AND EXISTS (SELECT 1 FROM market_send_credits WHERE installation_id=? AND status='reserved' AND operation_id=?)")
        .bind(this.device.installationId, intent.operationId, id, this.device.installationId, intent.operationId),
    ]);
    return this.prepared(await this.operation(intent.operationId));
  }
  private async prepared(row: OperationRow): Promise<PreparedSend> {
    const summary = await this.summary();
    const retry = row.authorized_at !== null || row.status === "verified";
    const pendingAds = !this.premium && !retry && row.decision !== "no_fill" && summary.strictCatchUp ? summary.pendingOfflineAds : 0;
    const currentAds = !this.premium && !row.decision ? 1 : 0;
    let permit: SendPermit | null = null;
    if (row.decision && pendingAds === 0 && row.intent_json) {
      const intent = JSON.parse(row.intent_json) as SendIntent;
      const outer: SendPermit = { policyVersion: 2, operationId: row.operation_id, sessionId: row.session_id, manifestDigest: row.manifest_digest, recipientIds: intent.recipientIds, senderInstallationId: this.device.installationId,
        decision: this.premium ? "premium" : row.decision, issuedAt: this.now, expiresAt: this.now + PERMIT_MS, proof: null };
      const { proof: _proof, ...payload } = outer; void _proof;
      outer.proof = await signMarketPayload({ iss: this.env.MARKET_ISSUER || "fileshareica", v: 2, purpose: "send", ...payload, senderKeyThumbprint: await thumbprint(this.device.publicKey), iat: Math.floor(this.now / 1000), exp: Math.floor(outer.expiresAt / 1000) }, this.env.MARKET_SIGNING_JWK);
      if (!outer.proof) throw new SendPolicyError(503, "Send authorization signing is not configured. No advertisement is required while setup is incomplete.", "SIGNING_DISABLED");
      await this.db.prepare("UPDATE market_send_operations SET authorized_at=COALESCE(authorized_at,?) WHERE id=?").bind(this.now, row.id).run();
      permit = outer;
    }
    let reservedCredit: SendAccessSummary['credit'] = null;
    if (row.credit_id && row.status !== 'verified' && row.decision !== 'no_fill') {
      const owned = await this.db.prepare("SELECT id FROM market_send_credits WHERE id=? AND installation_id=? AND (status='ready' OR (status='reserved' AND operation_id=?))").bind(row.credit_id, this.device.installationId, row.operation_id).first<{id:string}>();
      if (owned) {
        const proof = await signMarketPayload({iss:this.env.MARKET_ISSUER || 'fileshareica',v:2,purpose:'credit',creditId:owned.id,installationId:this.device.installationId,keyThumbprint:await thumbprint(this.device.publicKey),iat:Math.floor(this.now/1000)},this.env.MARKET_SIGNING_JWK);
        if (proof) reservedCredit = {id:owned.id,proof};
      }
    }
    return { operationId: row.operation_id, decision: permit?.decision || row.decision, permit, pendingAds, currentAds, adsRequired: pendingAds + currentAds, sendAccess: summary, reservedCredit };
  }
  async noFill(operationId: unknown, reason: unknown): Promise<PreparedSend> {
    const row = await this.operation(operationId);
    if (!this.development && reason !== "provider_unavailable" && reason !== "no_fill") throw new SendPolicyError(409, "Use the configured advertisement provider result.", "UNVERIFIED_AD_RESULT");
    if (!["no_fill", "timeout", "provider_error", "provider_unavailable"].includes(String(reason))) throw new SendPolicyError(400, "Use a recognized advertisement availability result.", "INVALID_NO_FILL");
    await this.db.batch([
      this.db.prepare("UPDATE market_send_credits SET status=CASE WHEN EXISTS (SELECT 1 FROM market_send_credits ready WHERE ready.installation_id=? AND ready.status='ready' AND ready.id<>?) THEN 'discarded' ELSE 'ready' END,operation_id=NULL WHERE id=? AND installation_id=? AND status='reserved' AND operation_id=? AND EXISTS (SELECT 1 FROM market_send_operations WHERE id=? AND status<>'verified')")
        .bind(this.device.installationId, row.credit_id, row.credit_id, this.device.installationId, row.operation_id, row.id),
      this.db.prepare("UPDATE market_send_operations SET decision='no_fill',credit_id=NULL WHERE id=? AND status<>'verified'").bind(row.id),
    ]);
    return this.prepared(await this.operation(operationId));
  }
  async commit(operationId: unknown, status: unknown): Promise<SendAccessSummary> {
    const row = await this.operation(operationId);
    if (!["verified", "released"].includes(String(status))) throw new SendPolicyError(400, "Use a valid send milestone.", "INVALID_MILESTONE");
    if (status === "verified" && !row.authorized_at && row.status !== "verified") throw new SendPolicyError(409, "This send has not been authorized yet.", "SEND_NOT_AUTHORIZED");
    if (status === "verified" && this.premium) await this.db.batch([
      this.db.prepare("UPDATE market_send_credits SET status=CASE WHEN EXISTS (SELECT 1 FROM market_send_credits ready WHERE ready.installation_id=? AND ready.status='ready' AND ready.id<>?) THEN 'discarded' ELSE 'ready' END,operation_id=NULL WHERE id=? AND installation_id=? AND status='reserved' AND operation_id=?")
        .bind(this.device.installationId, row.credit_id, row.credit_id, this.device.installationId, row.operation_id),
      this.db.prepare("UPDATE market_send_operations SET status='verified',decision='premium',credit_id=NULL,verified_at=COALESCE(verified_at,?) WHERE id=?").bind(this.now, row.id),
    ]);
    else if (status === "verified") await this.db.batch([
      this.db.prepare("UPDATE market_send_operations SET status='verified',verified_at=COALESCE(verified_at,?) WHERE id=?").bind(this.now, row.id),
      this.db.prepare("UPDATE market_send_credits SET status='spent',spent_at=? WHERE id=? AND installation_id=? AND (status='ready' OR (status='reserved' AND operation_id=?)) AND EXISTS (SELECT 1 FROM market_send_operations WHERE id=? AND status='verified')")
        .bind(this.now, row.credit_id, this.device.installationId, row.operation_id, row.id),
    ]);
    else await this.db.batch([
      this.db.prepare("UPDATE market_send_operations SET status='released' WHERE id=? AND status<>'verified'").bind(row.id),
      this.db.prepare("UPDATE market_send_credits SET status=CASE WHEN EXISTS (SELECT 1 FROM market_send_credits ready WHERE ready.installation_id=? AND ready.status='ready' AND ready.id<>?) THEN 'discarded' ELSE 'ready' END,operation_id=NULL WHERE id=? AND installation_id=? AND status='reserved' AND operation_id=? AND EXISTS (SELECT 1 FROM market_send_operations WHERE id=? AND status='released')")
        .bind(this.device.installationId, row.credit_id, row.credit_id, this.device.installationId, row.operation_id, row.id),
    ]);
    return this.summary();
  }
  async startAd(purpose: unknown, operationId: unknown): Promise<{ attemptId: string; readyAt: number }> {
    if (!["credit", "catchup", "send"].includes(String(purpose))) throw new SendPolicyError(409, "Advertising now applies to individual sends. Refresh this page.", "POLICY_CHANGED");
    if (!this.development) throw new SendPolicyError(503, "A verified advertisement provider is not configured. Sharing continues without an ad.", "ADS_DISABLED");
    const summary = await this.summary();
    if (this.premium) throw new SendPolicyError(409, "Premium does not require advertisements.", "PREMIUM_ACTIVE");
    if (purpose === "credit" && summary.creditAvailable) throw new SendPolicyError(409, "One unused credit is already ready.", "CREDIT_ALREADY_READY");
    if (purpose === "catchup" && !summary.pendingOfflineAds) throw new SendPolicyError(409, "No offline sends need an advertisement.", "NO_PENDING_ADS");
    if (purpose === "send") {
      const row = await this.operation(operationId);
      if (row.decision) throw new SendPolicyError(409, "This send already has its current-send authorization.", "SEND_ALREADY_AUTHORIZED");
      if (summary.pendingOfflineAds) throw new SendPolicyError(409, "Complete the pending offline-send advertisements first.", "CATCHUP_REQUIRED");
    }
    const id = crypto.randomUUID(); const readyAt = this.now + 5000;
    await this.db.prepare("INSERT INTO market_ad_attempts (id,installation_id,created_at,ready_at,expires_at,purpose,operation_id) VALUES (?,?,?,?,?,?,?)")
      .bind(id, this.device.installationId, this.now, readyAt, this.now + 10 * 60_000, String(purpose), purpose === "send" ? String(operationId) : null).run();
    return { attemptId: id, readyAt };
  }
  async completeAd(attemptId: unknown): Promise<void> {
    if (!this.development) throw new SendPolicyError(503, "Unverified advertisement completion cannot grant a reward.", "ADS_DISABLED");
    if (!opaque(attemptId)) throw new SendPolicyError(400, "Choose a test advertisement attempt.", "INVALID_AD");
    const attempt = await this.db.prepare("SELECT * FROM market_ad_attempts WHERE id=? AND installation_id=?").bind(attemptId, this.device.installationId).first<AttemptRow>();
    if (!attempt || !attempt.purpose) throw new SendPolicyError(409, "Advertising now applies to individual sends. Refresh this page.", "POLICY_CHANGED");
    if (attempt.completed_at !== null) return;
    if (attempt.ready_at > this.now || attempt.expires_at <= this.now) throw new SendPolicyError(409, "This test advertisement is not complete or has expired.", "AD_NOT_READY");
    const claim = crypto.randomUUID(); const conditions = "EXISTS (SELECT 1 FROM market_ad_attempts WHERE id=? AND completion_id=?)";
    const statements = [this.db.prepare("UPDATE market_ad_attempts SET completed_at=?,completion_id=? WHERE id=? AND installation_id=? AND completed_at IS NULL AND ready_at<=? AND expires_at>?")
      .bind(this.now, claim, attempt.id, this.device.installationId, this.now, this.now)];
    if (attempt.purpose === "credit") statements.push(this.db.prepare(`INSERT INTO market_send_credits (id,installation_id,status,created_at) SELECT ?,?,'ready',? WHERE NOT EXISTS (SELECT 1 FROM market_send_credits WHERE installation_id=? AND status='ready') AND ${conditions} ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), this.device.installationId, this.now, this.device.installationId, attempt.id, claim));
    if (attempt.purpose === "catchup") statements.push(this.db.prepare(`UPDATE market_offline_sends SET status='settled',settled_at=?,settlement_id=? WHERE id=(SELECT id FROM market_offline_sends WHERE installation_id=? AND status='pending' ORDER BY verified_at,created_at,id LIMIT 1) AND ${conditions}`)
      .bind(this.now, attempt.id, this.device.installationId, attempt.id, claim));
    if (attempt.purpose === "send") statements.push(
      this.db.prepare(`INSERT INTO market_send_credits (id,installation_id,status,operation_id,created_at) SELECT ?,?,'reserved',?,? WHERE EXISTS (SELECT 1 FROM market_send_operations WHERE id=? AND decision IS NULL) AND ${conditions} ON CONFLICT DO NOTHING`)
        .bind(attempt.id,this.device.installationId,attempt.operation_id!,this.now,this.key(attempt.operation_id!),attempt.id,claim),
      this.db.prepare(`UPDATE market_send_operations SET decision='ad_completed',credit_id=? WHERE id=? AND installation_id=? AND decision IS NULL AND ${conditions} AND EXISTS (SELECT 1 FROM market_send_credits WHERE id=? AND installation_id=? AND status='reserved' AND operation_id=?)`)
        .bind(attempt.id,this.key(attempt.operation_id!),this.device.installationId,attempt.id,claim,attempt.id,this.device.installationId,attempt.operation_id!),
      this.db.prepare(`UPDATE market_send_credits SET status=CASE WHEN EXISTS (SELECT 1 FROM market_send_credits ready WHERE ready.installation_id=? AND ready.status='ready' AND ready.id<>?) THEN 'discarded' ELSE 'ready' END,operation_id=NULL WHERE id=? AND installation_id=? AND status='reserved' AND EXISTS (SELECT 1 FROM market_send_operations WHERE id=? AND status='released' AND credit_id=?) AND ${conditions}`)
        .bind(this.device.installationId,attempt.id,attempt.id,this.device.installationId,this.key(attempt.operation_id!),attempt.id,attempt.id,claim),
    );
    await this.db.batch(statements);
  }
  async sync(value: unknown): Promise<{ sendAccess: SendAccessSummary; acknowledgedOperationIds: string[] }> {
    await this.init();
    if (!Array.isArray(value) || value.length > 100) throw new SendPolicyError(400, "Sync at most 100 offline-send events at once.", "INVALID_OFFLINE_EVENTS");
    const key = await crypto.subtle.importKey("jwk", this.device.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const parsed: { event: OfflineSendEvent; hash: string }[] = [];
    for (const item of value) {
      const v = record(item);
      if (!exact(v, ["operationId", "sessionId", "manifestDigest", "installationId", "verifiedAt", "creditId", "signature"]) || !opaque(v.operationId) || !opaque(v.sessionId) || typeof v.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(v.manifestDigest)
        || v.installationId !== this.device.installationId || !Number.isSafeInteger(v.verifiedAt) || Number(v.verifiedAt) <= 0 || Number(v.verifiedAt) > this.now + 60_000 || (v.creditId !== undefined && !opaque(v.creditId)) || typeof v.signature !== "string" || v.signature.length > 200) throw new SendPolicyError(400, "Invalid offline send receipt.", "INVALID_OFFLINE_EVENT");
      const event = v as unknown as OfflineSendEvent;
      try { if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unbase64url(event.signature), encoder.encode(offlineEventText(event)))) throw new Error(); }
      catch { throw new SendPolicyError(401, "Offline receipt ownership could not be verified.", "INVALID_OFFLINE_SIGNATURE"); }
      parsed.push({ event, hash: await sha256(offlineEventText(event)) });
    }
    const acknowledged: string[] = [];
    for (const { event, hash } of parsed) {
      const id = this.key(event.operationId);
      const prior = await this.db.prepare("SELECT event_hash FROM market_offline_sends WHERE id=?").bind(id).first<{ event_hash: string }>();
      if (prior) { if (prior.event_hash !== hash) throw new SendPolicyError(409, "This offline operation was already recorded with different details.", "OFFLINE_REPLAY"); acknowledged.push(event.operationId); continue; }
      const op = await this.db.prepare("SELECT * FROM market_send_operations WHERE id=?").bind(id).first<OperationRow>();
      if (op && (op.session_id !== event.sessionId || op.manifest_digest !== event.manifestDigest)) throw new SendPolicyError(409, "This receipt does not match its immutable send.", "OPERATION_REPLAY");
      const creditId = event.creditId || null;
      const settlement = crypto.randomUUID();
      await this.db.batch([
        this.db.prepare("INSERT INTO market_offline_sends (id,installation_id,operation_id,session_id,manifest_digest,event_hash,verified_at,created_at,status,credit_id,settlement_id) SELECT ?,?,?,?,?,?,?,?,CASE WHEN ?=1 OR ?<=(SELECT premium_cutoff FROM market_send_states WHERE installation_id=?) THEN 'cleared' WHEN EXISTS (SELECT 1 FROM market_send_operations WHERE id=? AND (authorized_at IS NOT NULL OR status='verified')) THEN 'covered' ELSE 'pending' END,COALESCE((SELECT credit_id FROM market_send_operations WHERE id=?),?),? WHERE NOT EXISTS (SELECT 1 FROM market_send_operations WHERE id=? AND (session_id<>? OR manifest_digest<>?)) ON CONFLICT(id) DO NOTHING")
          .bind(id, this.device.installationId, event.operationId, event.sessionId, event.manifestDigest, hash, event.verifiedAt, this.now, this.premium ? 1 : 0, event.verifiedAt, this.device.installationId, id, id, creditId, settlement, id, event.sessionId, event.manifestDigest),
        this.db.prepare("UPDATE market_send_credits SET status='spent',spent_at=?,operation_id=? WHERE id=(SELECT credit_id FROM market_offline_sends WHERE id=? AND settlement_id=?) AND installation_id=? AND (status='ready' OR (status='reserved' AND operation_id=?)) AND EXISTS (SELECT 1 FROM market_offline_sends WHERE id=? AND settlement_id=? AND status IN ('pending','covered'))")
          .bind(this.now, event.operationId, id, settlement, this.device.installationId, event.operationId, id, settlement),
        this.db.prepare("UPDATE market_offline_sends SET status='covered' WHERE id=? AND settlement_id=? AND status='pending' AND EXISTS (SELECT 1 FROM market_send_credits WHERE id=market_offline_sends.credit_id AND installation_id=? AND status='spent' AND operation_id=?)")
          .bind(id, settlement, this.device.installationId, event.operationId),
        this.db.prepare("INSERT INTO market_send_operations (id,installation_id,operation_id,session_id,manifest_digest,decision,status,created_at,verified_at) SELECT ?,?,?,?,?,'offline','verified',?,? WHERE EXISTS (SELECT 1 FROM market_offline_sends WHERE id=? AND settlement_id=?) ON CONFLICT(id) DO UPDATE SET status='verified',verified_at=COALESCE(verified_at,excluded.verified_at)")
          .bind(id, this.device.installationId, event.operationId, event.sessionId, event.manifestDigest, this.now, event.verifiedAt, id, settlement),
      ]);
      const stored = await this.db.prepare("SELECT event_hash FROM market_offline_sends WHERE id=?").bind(id).first<{ event_hash: string }>();
      if (!stored || stored.event_hash !== hash) throw new SendPolicyError(409, "This offline receipt conflicts with an earlier operation.", "OFFLINE_REPLAY");
      acknowledged.push(event.operationId);
    }
    return { sendAccess: await this.summary(), acknowledgedOperationIds: [...new Set(acknowledged)] };
  }
}
