import type { AccessKind, AccessState, DeviceAssertion, MarketConfig, PublicAccount, PublicOrder, RegisteredDevice } from "../market/types";
import { DEVICE_REPLACEMENT_MS, OFFLINE_LEASE_MS, PLANS, getPlan } from "../market/plans";
import { ApiError, randomToken, readBody, sha256 } from "./policy";
import { publicSigningKey, signClaims, verifyAssertion, verifyCashfreeSignature, verifyGoogleToken } from "./market-crypto";
import { SendMarketService, SendPolicyError } from "./send-market";

export interface MarketEnvironment {
  MARKET_DEV_MODE?: string; MARKET_SIGNING_JWK?: string; MARKET_ISSUER?: string; GOOGLE_CLIENT_ID?: string;
  CASHFREE_CLIENT_ID?: string; CASHFREE_CLIENT_SECRET?: string; CASHFREE_MODE?: string; CASHFREE_API_VERSION?: string;
  MARKET_PUBLIC_ORIGIN?: string; ADSENSE_PUBLISHER_ID?: string; MARKET_SUPPORT_EMAIL?: string;
}
interface AccountRow { id: string; google_subject: string; email: string; name: string; paid_until: number; }
interface InstallRow { id: string; key_thumbprint: string; device_class: string; ad_until: number; grace_until: number; last_grace_at: number; }
interface SessionRow { token_hash: string; account_id: string; installation_id: string; authenticated_at: number; expires_at: number; }
interface DeviceRow { id: string; account_id: string; installation_id: string; device_class: "desktop" | "mobile"; label: string; created_at: number; last_seen_at: number; revoked_at: number | null; }
interface OrderRow { id: string; account_id: string; plan_id: PublicOrder["planId"]; amount_paise: number; currency: "INR"; months: number; provider: "demo" | "cashfree"; status: PublicOrder["status"]; created_at: number; paid_at: number | null; checkout_session_id: string | null; }
const SESSION_MS = 30 * 24 * 60 * 60_000;
const FRESH_AUTH_MS = 5 * 60_000;
const COOKIE = "fileshare_account";
export class MarketError extends ApiError { constructor(status: number, message: string, public code: string) { super(status, message); } }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function safeName(value: unknown): string { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || "Member" : "Member"; }
export function isDevelopment(env: MarketEnvironment, request: Request): boolean {
  return env.MARKET_DEV_MODE === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);
}
function publicOrder(row: OrderRow): PublicOrder {
  return { id: row.id, planId: row.plan_id, amountPaise: row.amount_paise, currency: row.currency, status: row.status, provider: row.provider, createdAt: row.created_at, paidAt: row.paid_at, ...(row.checkout_session_id ? { checkoutSessionId: row.checkout_session_id } : {}) };
}
export function marketConfig(env: MarketEnvironment, request: Request): MarketConfig {
  const development = isDevelopment(env, request);
  const cashfree = env.CASHFREE_CLIENT_ID && env.CASHFREE_CLIENT_SECRET && ["sandbox", "live"].includes(env.CASHFREE_MODE ?? "") && env.MARKET_PUBLIC_ORIGIN;
  return { advertisingPolicyVersion: 2, development, googleClientId: env.GOOGLE_CLIENT_ID || null, paymentMode: cashfree ? env.CASHFREE_MODE as "sandbox" | "live" : development ? "demo" : "disabled",
    adsMode: development ? "demo" : "disabled", publisherId: /^ca-pub-\d+$/.test(env.ADSENSE_PUBLISHER_ID ?? "") ? env.ADSENSE_PUBLISHER_ID! : null,
    supportEmail: env.MARKET_SUPPORT_EMAIL || null, publicKey: publicSigningKey(env.MARKET_SIGNING_JWK), issuer: env.MARKET_ISSUER || "fileshareica", plans: PLANS };
}

/** Trusted account metadata only; no files, chat or invitation secrets enter this service. */
export class MarketService {
  private assertion?: DeviceAssertion;
  private installation?: InstallRow;
  private session?: SessionRow | null;
  private responseCookies: string[] = [];
  constructor(private db: D1Database, private env: MarketEnvironment, private request: Request, private now = Date.now(), private fetcher: typeof fetch = fetch) {}
  private development(): void { if (!isDevelopment(this.env, this.request)) throw new MarketError(404, "This development action is unavailable.", "NOT_AVAILABLE"); }
  private async limit(key: string, max: number, windowMs = 60_000): Promise<void> {
    const end = (Math.floor(this.now / windowMs) + 1) * windowMs;
    const result = await this.db.prepare("INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count")
      .bind(`market:${key}:${Math.floor(this.now / windowMs)}`, end).first<{ count: number }>();
    if (!result || result.count > max) throw new MarketError(429, "Too many requests. Wait a minute and try again.", "RATE_LIMIT");
  }
  private async validateDevice(value: unknown): Promise<void> {
    const proof = await verifyAssertion(value, this.now);
    const a = proof.assertion;
    const inserted = await this.db.prepare("INSERT INTO market_installations (id,key_thumbprint,public_key_json,device_class,label,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label WHERE key_thumbprint=excluded.key_thumbprint AND device_class=excluded.device_class RETURNING *")
      .bind(a.device.installationId, proof.thumbprint, JSON.stringify({ kty: "EC", crv: "P-256", x: a.device.publicKey.x, y: a.device.publicKey.y }), a.device.deviceClass, safeName(a.device.label), this.now).first<InstallRow>();
    if (!inserted) throw new MarketError(401, "This installation key no longer matches. Restore its original browser storage.", "DEVICE_KEY_MISMATCH");
    const nonce = await this.db.prepare("INSERT INTO market_nonces (id,expires_at) VALUES (?,?) ON CONFLICT(id) DO NOTHING RETURNING id")
      .bind(`${a.device.installationId}:${a.nonce}`, this.now + 10 * 60_000).first();
    if (!nonce) throw new MarketError(409, "This installation proof was already used. Retry the request.", "REPLAYED_ASSERTION");
    this.assertion = a; this.installation = inserted;
  }
  private async authenticate(required = false): Promise<AccountRow | null> {
    const cookie = this.request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) { if (required) throw new MarketError(401, "Sign in to continue.", "LOGIN_REQUIRED"); return null; }
    this.session = await this.db.prepare("SELECT * FROM market_sessions WHERE token_hash=? AND expires_at>?").bind(await sha256(cookie), this.now).first<SessionRow>();
    if (!this.session || (this.assertion && this.session.installation_id !== this.assertion.device.installationId)) {
      if (required) throw new MarketError(401, "Sign in again on this installation.", "LOGIN_REQUIRED"); return null;
    }
    const account = await this.db.prepare("SELECT * FROM market_accounts WHERE id=? AND google_subject NOT LIKE 'deleted:%'").bind(this.session.account_id).first<AccountRow>();
    if (!account && required) throw new MarketError(401, "Sign in to continue.", "LOGIN_REQUIRED");
    return account;
  }
  private cookie(token: string, remove = false): void {
    const secure = new URL(this.request.url).protocol === "https:" ? "; Secure" : "";
    this.responseCookies.push(`${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${remove ? 0 : SESSION_MS / 1000}${secure}`);
  }
  private async logIn(subject: string, email: string, name: string, authenticatedAt = this.now): Promise<AccessState> {
    const account = await this.db.prepare("INSERT INTO market_accounts (id,google_subject,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT(google_subject) DO UPDATE SET email=excluded.email,name=excluded.name RETURNING *")
      .bind(crypto.randomUUID(), subject, email, safeName(name), this.now).first<AccountRow>();
    if (!account || !this.assertion) throw new Error("Account creation failed");
    const token = randomToken();
    const tokenHash = await sha256(token);
    await this.db.prepare("INSERT INTO market_sessions (token_hash,account_id,installation_id,authenticated_at,expires_at) VALUES (?,?,?,?,?)")
      .bind(tokenHash, account.id, this.assertion.device.installationId, authenticatedAt, this.now + SESSION_MS).run();
    this.cookie(token);
    this.session = { token_hash: tokenHash, account_id: account.id, installation_id: this.assertion.device.installationId, authenticated_at: authenticatedAt, expires_at: this.now + SESSION_MS };
    await this.enroll(account, false);
    return this.state(account);
  }
  private async enroll(account: AccountRow, replace: boolean): Promise<void> {
    const a = this.assertion!;
    const existing = await this.db.prepare("SELECT * FROM market_devices WHERE account_id=? AND device_class=? AND revoked_at IS NULL").bind(account.id, a.device.deviceClass).first<DeviceRow>();
    if (existing?.installation_id === a.device.installationId) {
      await this.db.prepare("UPDATE market_devices SET last_seen_at=?,label=? WHERE id=?").bind(this.now, safeName(a.device.label), existing.id).run(); return;
    }
    if (existing && !replace) return;
    if (replace) {
      if (!this.session || this.now - this.session.authenticated_at > FRESH_AUTH_MS) throw new MarketError(401, "Sign in with Google again before replacing a device.", "FRESH_LOGIN_REQUIRED");
      const changeId = `${account.id}:${a.device.deviceClass}`;
      const operation = crypto.randomUUID();
      // D1 batch is a transaction; the cooldown claim and revocation cannot diverge.
      const results = await this.db.batch([
        this.db.prepare("INSERT INTO market_device_changes (id,replaced_at,operation_id) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET replaced_at=excluded.replaced_at,operation_id=excluded.operation_id WHERE replaced_at<=? RETURNING id").bind(changeId, this.now, operation, this.now - DEVICE_REPLACEMENT_MS),
        this.db.prepare("UPDATE market_devices SET revoked_at=? WHERE account_id=? AND device_class=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM market_device_changes WHERE id=? AND operation_id=?)").bind(this.now, account.id, a.device.deviceClass, changeId, operation),
        this.db.prepare("INSERT INTO market_devices (id,account_id,installation_id,device_class,label,created_at,last_seen_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM market_device_changes WHERE id=? AND operation_id=?) AND NOT EXISTS (SELECT 1 FROM market_devices WHERE account_id=? AND device_class=? AND revoked_at IS NULL) AND EXISTS (SELECT 1 FROM market_accounts WHERE id=? AND google_subject NOT LIKE 'deleted:%')")
          .bind(crypto.randomUUID(), account.id, a.device.installationId, a.device.deviceClass, safeName(a.device.label), this.now, this.now, changeId, operation, account.id, a.device.deviceClass, account.id),
      ]);
      if (!results[0].results.length) throw new MarketError(429, "This device category can be replaced once every 24 hours.", "DEVICE_COOLDOWN");
    } else {
      await this.db.prepare("INSERT INTO market_devices (id,account_id,installation_id,device_class,label,created_at,last_seen_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM market_devices WHERE account_id=? AND device_class=? AND revoked_at IS NULL) AND EXISTS (SELECT 1 FROM market_accounts WHERE id=? AND google_subject NOT LIKE 'deleted:%') ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), account.id, a.device.installationId, a.device.deviceClass, safeName(a.device.label), this.now, this.now, account.id, a.device.deviceClass, account.id).run();
    }
  }
  async state(account: AccountRow | null): Promise<AccessState> {
    // Refresh account authority after any concurrent renewal, deletion or refund.
    if (account) account = await this.db.prepare("SELECT * FROM market_accounts WHERE id=? AND google_subject NOT LIKE 'deleted:%'").bind(account.id).first<AccountRow>();
    const a = this.assertion!;
    const install = await this.db.prepare("SELECT * FROM market_installations WHERE id=?").bind(a.device.installationId).first<InstallRow>();
    if (!install) throw new Error("Missing installation");
    const rows = account ? (await this.db.prepare("SELECT * FROM market_devices WHERE account_id=? AND revoked_at IS NULL ORDER BY created_at").bind(account.id).all<DeviceRow>()).results : [];
    const slot = rows.find(d => d.device_class === a.device.deviceClass);
    const registered = slot?.installation_id === a.device.installationId;
    const paid = Boolean(account && account.paid_until > this.now && registered);
    const kind: AccessKind = paid ? "paid" : "none";
    const expiresAt = paid ? Math.min(account!.paid_until, this.now + OFFLINE_LEASE_MS) : null;
    const config = marketConfig(this.env, this.request);
    const proof = expiresAt && config.publicKey ? await signClaims({ iss: config.issuer, v: 1, installationId: a.device.installationId, keyThumbprint: install.key_thumbprint, kind, hyperSpeed: paid,
      iat: Math.floor(this.now / 1000), exp: Math.floor(expiresAt / 1000), paidUntil: account?.paid_until || null }, this.env.MARKET_SIGNING_JWK) : null;
    const devices: RegisteredDevice[] = rows.map(d => ({ id: d.id, deviceClass: d.device_class, label: d.label, installationId: d.installation_id, createdAt: d.created_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at }));
    const orders = account ? (await this.db.prepare("SELECT * FROM market_orders WHERE account_id=? ORDER BY created_at DESC LIMIT 30").bind(account.id).all<OrderRow>()).results.map(publicOrder) : [];
    const publicAccount: PublicAccount | null = account ? { id: account.id, name: account.name, email: account.email } : null;
    const sendAccess = await new SendMarketService(this.db, a.device, this.env, this.now, paid, isDevelopment(this.env, this.request)).summary();
    return { sendAccess, kind, allowed: kind !== "none" && Boolean(proof), hyperSpeed: paid && Boolean(proof), expiresAt, paidUntil: account?.paid_until || null, serverNow: this.now, proof,
      deviceStatus: !account ? "guest" : registered ? "registered" : slot ? "replacement_required" : "unregistered", account: publicAccount, devices, orders, config };
  }
  private async order(id: string, account: AccountRow): Promise<OrderRow> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new MarketError(404, "Order not found.", "ORDER_NOT_FOUND");
    const row = await this.db.prepare("SELECT * FROM market_orders WHERE id=? AND account_id=?").bind(id, account.id).first<OrderRow>();
    if (!row) throw new MarketError(404, "Order not found.", "ORDER_NOT_FOUND"); return row;
  }
  private async sendService(account: AccountRow | null): Promise<SendMarketService> {
    const device = this.assertion!.device;
    const registered = account ? await this.db.prepare("SELECT d.id FROM market_devices d JOIN market_accounts a ON a.id=d.account_id WHERE a.id=? AND a.paid_until>? AND a.google_subject NOT LIKE 'deleted:%' AND d.installation_id=? AND d.revoked_at IS NULL")
      .bind(account.id, this.now, device.installationId).first() : null;
    return new SendMarketService(this.db, device, this.env, this.now, Boolean(registered), isDevelopment(this.env, this.request));
  }
  private cashfreeBase(): string { return this.env.CASHFREE_MODE === "live" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg"; }
  private cashfreeHeaders(): Record<string, string> { return { "Content-Type": "application/json", "x-client-id": this.env.CASHFREE_CLIENT_ID!, "x-client-secret": this.env.CASHFREE_CLIENT_SECRET!, "x-api-version": this.env.CASHFREE_API_VERSION || "2025-01-01" }; }
  private async provisionCashfreeOrder(order: OrderRow, account: AccountRow, phone: string): Promise<OrderRow> {
    let origin: URL;
    try { origin = new URL(this.env.MARKET_PUBLIC_ORIGIN!); if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error(); } catch { throw new MarketError(503, "A secure checkout return domain must be configured.", "PAYMENTS_DISABLED"); }
    const requestId = order.id.slice(3).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    try {
      const response = await this.fetcher(`${this.cashfreeBase()}/orders`, { method: "POST", headers: { ...this.cashfreeHeaders(), "x-idempotency-key": requestId }, signal: AbortSignal.timeout(12_000), body: JSON.stringify({ order_id: order.id, order_amount: order.amount_paise / 100, order_currency: "INR", order_expiry_time: new Date(order.created_at + 60 * 60_000).toISOString(), customer_details: { customer_id: account.id, customer_email: account.email, customer_name: account.name, customer_phone: phone }, order_meta: { return_url: `${origin.origin}/payment/return?order_id=${order.id}`, notify_url: `${origin.origin}/api/market/webhooks/cashfree` } }) });
      const result = object(await response.json());
      if (!response.ok || result.order_id !== order.id || typeof result.payment_session_id !== "string") throw new Error("Checkout unavailable");
      await this.db.prepare("UPDATE market_orders SET checkout_session_id=? WHERE id=?").bind(result.payment_session_id, order.id).run();
      return this.order(order.id, account);
    } catch { throw new MarketError(503, "Checkout confirmation is pending. Retry this same plan to recover its existing order; do not make another payment.", "CHECKOUT_UNAVAILABLE"); }
  }
  private async recoverCashfreeOrder(order: OrderRow, account: AccountRow, phone: string): Promise<OrderRow | null> {
    try {
      const response = await this.fetcher(`${this.cashfreeBase()}/orders/${order.id}`, { headers: this.cashfreeHeaders(), signal: AbortSignal.timeout(8000) });
      if (response.status === 404) {
        // A definitive absence can retry the same ID and idempotency key, never a second order.
        if (order.created_at + 60 * 60_000 > this.now) return this.provisionCashfreeOrder(order, account, phone);
        await this.db.prepare("UPDATE market_orders SET status='failed' WHERE id=? AND status='pending'").bind(order.id).run(); return null;
      }
      const result = object(await response.json());
      if (!response.ok || result.order_id !== order.id || Math.round(Number(result.order_amount) * 100) !== order.amount_paise || result.order_currency !== "INR") throw new Error("Order unresolved");
      if (["EXPIRED", "TERMINATED"].includes(String(result.order_status))) {
        await this.db.prepare("UPDATE market_orders SET status='failed' WHERE id=? AND status='pending'").bind(order.id).run(); return null;
      }
      if (result.order_status === "PAID") {
        await this.reconcile(order); const updated = await this.order(order.id, account);
        if (updated.status !== "paid") throw new MarketError(409, "Your payment is still being confirmed. Check the existing order before paying again.", "PAYMENT_PENDING");
        return updated;
      }
      if (result.order_status !== "ACTIVE" || typeof result.payment_session_id !== "string") throw new Error("Order unresolved");
      await this.db.prepare("UPDATE market_orders SET checkout_session_id=? WHERE id=? AND status='pending'").bind(result.payment_session_id, order.id).run();
      return this.order(order.id, account);
    } catch (error) {
      if (error instanceof MarketError) throw error;
      throw new MarketError(503, "An existing checkout needs confirmation. Retry its plan or check your orders; a second checkout was not created.", "PAYMENT_PENDING");
    }
  }
  private async createOrder(account: AccountRow, body: Record<string, unknown>): Promise<PublicOrder> {
    await this.limit(`order:${account.id}`, 8, 10 * 60_000);
    let plan; try { plan = getPlan(body.planId); } catch { throw new MarketError(400, "Choose a valid prepaid plan.", "INVALID_PLAN"); }
    const mode = marketConfig(this.env, this.request).paymentMode;
    if (mode === "disabled") throw new MarketError(503, "Checkout is not configured yet. No money has been charged.", "PAYMENTS_DISABLED");
    if (!publicSigningKey(this.env.MARKET_SIGNING_JWK)) throw new MarketError(503, "Access signing must be configured before checkout.", "SIGNING_DISABLED");
    const requestId = crypto.randomUUID();
    const id = `fs_${requestId.replace(/-/g, "")}`;
    const provider = mode === "demo" ? "demo" : "cashfree";
    let phone = "";
    if (provider === "cashfree") {
      phone = typeof body.customerPhone === "string" ? body.customerPhone.trim().replace(/^\+91/, "") : "";
      if (!/^[6-9]\d{9}$/.test(phone)) throw new MarketError(400, "Enter a 10-digit Indian mobile number for payment checkout.", "PHONE_REQUIRED");
      const pending = await this.db.prepare("SELECT * FROM market_orders WHERE account_id=? AND provider='cashfree' AND status='pending' ORDER BY created_at LIMIT 1").bind(account.id).first<OrderRow>();
      if (pending) {
        const recovered = await this.recoverCashfreeOrder(pending, account, phone);
        if (recovered) {
          if (recovered.plan_id !== plan.id && recovered.status !== "paid") throw new MarketError(409, "Finish or resolve your existing checkout before choosing another plan.", "PAYMENT_PENDING");
          return publicOrder(recovered);
        }
      }
    }
    const inserted = await this.db.prepare("INSERT INTO market_orders (id,account_id,plan_id,amount_paise,currency,months,provider,status,created_at) SELECT ?,?,?,?,'INR',?,?,'pending',? WHERE EXISTS (SELECT 1 FROM market_accounts WHERE id=? AND google_subject NOT LIKE 'deleted:%') ON CONFLICT DO NOTHING RETURNING id")
      .bind(id, account.id, plan.id, plan.amountPaise, plan.months, provider, this.now, account.id).first();
    if (!inserted) {
      const pending = provider === "cashfree" ? await this.db.prepare("SELECT * FROM market_orders WHERE account_id=? AND provider='cashfree' AND status='pending' LIMIT 1").bind(account.id).first<OrderRow>() : null;
      if (!pending) throw new MarketError(401, "This account is no longer available. Sign in again.", "LOGIN_REQUIRED");
      if (pending.plan_id !== plan.id) throw new MarketError(409, "Resolve your existing checkout before choosing another plan.", "PAYMENT_PENDING");
      const recovered = await this.recoverCashfreeOrder(pending, account, phone);
      if (!recovered) throw new MarketError(409, "The previous checkout has closed. Select your plan again.", "CHECKOUT_CLOSED");
      return publicOrder(recovered);
    }
    if (provider === "cashfree") return publicOrder(await this.provisionCashfreeOrder(await this.order(id, account), account, phone));
    return publicOrder(await this.order(id, account));
  }
  /** Each D1 batch is atomic. The SQL extends the current expiry inside the transaction. */
  async grantPayment(id: string, paymentId: string, amountPaise: number, currency: string, provider: string): Promise<void> {
    const order = await this.db.prepare("SELECT * FROM market_orders WHERE id=?").bind(id).first<OrderRow>();
    if (!order || order.provider !== provider || order.amount_paise !== amountPaise || currency !== "INR") throw new MarketError(400, "Payment does not match its order.", "PAYMENT_MISMATCH");
    // Calendar months clamp month-end rather than adding a fixed number of days.
    const base = `MAX(paid_until, ${this.now})`;
    const first = `datetime(${base}/1000, 'unixepoch', 'start of month', '+' || ${order.months} || ' months')`;
    const days = `MIN(CAST(strftime('%d', ${base}/1000, 'unixepoch') AS INTEGER), CAST(strftime('%d', ${first}, '+1 month', '-1 day') AS INTEGER))-1`;
    const expiry = `(CAST(strftime('%s', ${first}, '+' || (${days}) || ' days') AS INTEGER)*1000 + (${base}%86400000))`;
    await this.db.batch([
      this.db.prepare("INSERT INTO market_payment_events (id,order_id,status,created_at) VALUES (?,?,'SUCCESS',?) ON CONFLICT(id) DO NOTHING").bind(paymentId, id, this.now),
      this.db.prepare(`UPDATE market_accounts SET paid_until=${expiry} WHERE id=? AND google_subject NOT LIKE 'deleted:%' AND EXISTS (SELECT 1 FROM market_orders WHERE id=? AND status IN ('pending','failed')) AND NOT EXISTS (SELECT 1 FROM market_grants WHERE order_id=?) AND EXISTS (SELECT 1 FROM market_payment_events WHERE id=? AND order_id=? AND status='SUCCESS')`)
        .bind(order.account_id, id, id, paymentId, id),
      this.db.prepare("INSERT INTO market_grants (order_id,payment_id,account_id,created_at,ends_at) SELECT ?,?,?,?,paid_until FROM market_accounts WHERE id=? AND EXISTS (SELECT 1 FROM market_orders WHERE id=? AND status IN ('pending','failed')) AND EXISTS (SELECT 1 FROM market_payment_events WHERE id=? AND order_id=? AND status='SUCCESS') ON CONFLICT DO NOTHING")
        .bind(id, paymentId, order.account_id, this.now, order.account_id, id, paymentId, id),
      this.db.prepare("UPDATE market_orders SET status='paid',paid_at=COALESCE(paid_at,?) WHERE id=? AND status IN ('pending','failed') AND EXISTS (SELECT 1 FROM market_grants WHERE order_id=?)").bind(this.now, id, id),
    ]);
  }
  private async reconcile(order: OrderRow): Promise<void> {
    if (order.provider !== "cashfree" || order.status === "paid" || order.status === "refunded") return;
    await this.limit(`reconcile:${order.id}`, 3);
    try {
      const response = await this.fetcher(`${this.cashfreeBase()}/orders/${order.id}/payments`, { headers: this.cashfreeHeaders(), signal: AbortSignal.timeout(8000) });
      const payments: unknown = await response.json();
      if (!response.ok || !Array.isArray(payments)) return;
      const success = payments.map(object).find(p => p.payment_status === "SUCCESS");
      if (success && (typeof success.cf_payment_id === "number" || typeof success.cf_payment_id === "string") && Number.isFinite(Number(success.payment_amount))) {
        await this.grantPayment(order.id, `cashfree:${success.cf_payment_id}`, Math.round(Number(success.payment_amount) * 100), String(success.payment_currency), "cashfree");
      }
    } catch (error) { if (error instanceof MarketError && error.code === "PAYMENT_MISMATCH") throw error; }
  }
  private async refundDemoDuplicate(order: OrderRow, account: AccountRow): Promise<void> {
    this.development();
    if (order.provider !== "demo" || !["paid", "refunded"].includes(order.status)) throw new MarketError(409, "Only a paid demo duplicate can be refunded here.", "REFUND_NOT_AVAILABLE");
    if (order.status === "refunded") return;
    const original = await this.db.prepare("SELECT id FROM market_orders WHERE account_id=? AND id<>? AND provider='demo' AND status='paid' AND plan_id=? AND amount_paise=? AND ABS(created_at-?)<=600000 LIMIT 1")
      .bind(account.id, order.id, order.plan_id, order.amount_paise, order.created_at).first();
    if (!original) throw new MarketError(409, "No matching duplicate paid order was found. General refunds are not offered by this demo.", "NOT_DUPLICATE");
    const base = "MAX(chain.ends_at, paid.paid_at)";
    const first = `datetime(${base}/1000,'unixepoch','start of month','+'||paid.months||' months')`;
    const day = `MIN(CAST(strftime('%d',${base}/1000,'unixepoch') AS INTEGER),CAST(strftime('%d',${first},'+1 month','-1 day') AS INTEGER))-1`;
    const expiry = `(CAST(strftime('%s',${first},'+'||(${day})||' days') AS INTEGER)*1000+(${base}%86400000))`;
    // Rebuild all remaining grants in order, preserving calendar-month behavior.
    const rebuild = `WITH RECURSIVE paid AS (SELECT o.months,o.paid_at,ROW_NUMBER() OVER (ORDER BY g.rowid) AS n FROM market_orders o JOIN market_grants g ON g.order_id=o.id WHERE o.account_id=? AND o.status='paid'), chain(n,ends_at) AS (VALUES(0,0) UNION ALL SELECT paid.n,${expiry} FROM paid JOIN chain ON paid.n=chain.n+1) SELECT ends_at FROM chain ORDER BY n DESC LIMIT 1`;
    const results = await this.db.batch([
      this.db.prepare("UPDATE market_orders SET status='refunded' WHERE id=? AND account_id=? AND provider='demo' AND status='paid' AND EXISTS (SELECT 1 FROM market_orders other WHERE other.account_id=? AND other.id<>? AND other.provider='demo' AND other.status='paid' AND other.plan_id=? AND other.amount_paise=? AND ABS(other.created_at-?)<=600000) RETURNING id")
        .bind(order.id, account.id, account.id, order.id, order.plan_id, order.amount_paise, order.created_at),
      this.db.prepare("INSERT INTO market_payment_events (id,order_id,status,created_at) SELECT ?,?,'REFUND_SUCCESS',? WHERE EXISTS (SELECT 1 FROM market_orders WHERE id=? AND status='refunded') ON CONFLICT(id) DO NOTHING").bind(`demo-refund:${order.id}`, order.id, this.now, order.id),
      this.db.prepare(`UPDATE market_accounts SET paid_until=CASE WHEN google_subject LIKE 'deleted:%' THEN 0 ELSE (${rebuild}) END WHERE id=?`).bind(account.id, account.id),
    ]);
    if (!results[0].results.length) throw new MarketError(409, "A matching paid duplicate is no longer available.", "NOT_DUPLICATE");
  }
  private async webhook(): Promise<unknown> {
    if (!this.env.CASHFREE_CLIENT_SECRET || !["sandbox", "live"].includes(this.env.CASHFREE_MODE ?? "")) throw new MarketError(503, "Payment webhooks are disabled.", "PAYMENTS_DISABLED");
    const raw = await boundedText(this.request, 128 * 1024);
    await verifyCashfreeSignature(raw, this.request.headers.get("x-webhook-timestamp"), this.request.headers.get("x-webhook-signature"), this.env.CASHFREE_CLIENT_SECRET, this.now);
    let body: Record<string, unknown>; try { body = object(JSON.parse(raw)); } catch { throw new MarketError(400, "Invalid payment event.", "INVALID_EVENT"); }
    const data = object(body.data); const order = object(data.order); const payment = object(data.payment);
    if (payment.payment_status !== "SUCCESS") return { received: true };
    if (typeof order.order_id !== "string" || !["number", "string"].includes(typeof payment.cf_payment_id) || !Number.isFinite(Number(order.order_amount)) || !Number.isFinite(Number(payment.payment_amount)) || Math.round(Number(order.order_amount) * 100) !== Math.round(Number(payment.payment_amount) * 100) || order.order_currency !== payment.payment_currency) throw new MarketError(400, "Invalid successful payment event.", "INVALID_EVENT");
    await this.grantPayment(order.order_id, `cashfree:${payment.cf_payment_id}`, Math.round(Number(order.order_amount) * 100), String(order.order_currency), "cashfree");
    return { received: true };
  }
  async dispatch(path: string): Promise<Response> {
    try {
      let output: unknown;
      const method = this.request.method;
      if (path === "config" && method === "GET") output = marketConfig(this.env, this.request);
      else if (path === "webhooks/cashfree" && method === "POST") output = await this.webhook();
      else if (/^orders\/[^/]+$/.test(path) && method === "GET") {
        const account = (await this.authenticate(true))!; const id = path.split("/")[1];
        const row = await this.order(id, account); await this.reconcile(row); output = { order: publicOrder(await this.order(id, account)) };
      } else {
        if (method !== "POST") throw new MarketError(404, "This action does not exist.", "NOT_FOUND");
        requireMarketOrigin(this.request);
        const address = this.request.headers.get("cf-connecting-ip") || "local";
        await this.limit(`request:${await sha256(address)}`, 120);
        if (crypto.getRandomValues(new Uint8Array(1))[0] < 8) await this.db.batch([
          this.db.prepare("DELETE FROM market_nonces WHERE id IN (SELECT id FROM market_nonces WHERE expires_at<=? LIMIT 500)").bind(this.now),
          this.db.prepare("DELETE FROM market_ad_attempts WHERE id IN (SELECT id FROM market_ad_attempts WHERE expires_at<=? LIMIT 100)").bind(this.now),
          this.db.prepare("DELETE FROM market_sessions WHERE token_hash IN (SELECT token_hash FROM market_sessions WHERE expires_at<=? LIMIT 100)").bind(this.now),
          this.db.prepare("DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at<=? LIMIT 500)").bind(this.now),
        ]);
        const body = await readBody(this.request);
        await this.validateDevice(body.assertion);
        const account = await this.authenticate();
        switch (path) {
          case "access": output = await this.state(account); break;
          case "auth/google": {
            await this.limit(`login:${this.assertion!.device.installationId}`, 10, 10 * 60_000);
            const google = await verifyGoogleToken(body.credential, this.env.GOOGLE_CLIENT_ID, this.now, this.fetcher);
            output = await this.logIn(`google:${google.sub}`, google.email, google.name, Math.min(this.now, google.iat * 1000)); break;
          }
          case "auth/demo": {
            this.development();
            const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new MarketError(400, "Enter a demo email address.", "INVALID_EMAIL");
            output = await this.logIn(`demo:${email}`, email, safeName(body.name)); break;
          }
          case "auth/logout": {
            if (this.session) await this.db.prepare("DELETE FROM market_sessions WHERE token_hash=?").bind(this.session.token_hash).run();
            this.cookie("", true); output = await this.state(null); break;
          }
          case "account/delete": {
            if (!account || !this.session) throw new MarketError(401, "Sign in before deleting your account.", "LOGIN_REQUIRED");
            if (this.now - this.session.authenticated_at > FRESH_AUTH_MS) throw new MarketError(401, "Sign in again before deleting your account.", "FRESH_LOGIN_REQUIRED");
            await this.db.batch([
              this.db.prepare("DELETE FROM market_sessions WHERE account_id=?").bind(account.id),
              this.db.prepare("DELETE FROM market_devices WHERE account_id=?").bind(account.id),
              this.db.prepare("DELETE FROM market_device_changes WHERE id IN (?,?)").bind(`${account.id}:desktop`, `${account.id}:mobile`),
              this.db.prepare("UPDATE market_accounts SET google_subject=?,email='',name='Deleted account',paid_until=0 WHERE id=?").bind(`deleted:${crypto.randomUUID()}`, account.id),
            ]);
            this.cookie("", true); output = { ok: true }; break;
          }
          case "devices/enroll": {
            if (!account) throw new MarketError(401, "Sign in to register this device.", "LOGIN_REQUIRED");
            await this.enroll(account, false); output = await this.state(account); break;
          }
          case "devices/replace": {
            if (!account) throw new MarketError(401, "Sign in to replace a device.", "LOGIN_REQUIRED");
            await this.enroll(account, true); output = await this.state(account); break;
          }
          case "orders": {
            if (!account) throw new MarketError(401, "Sign in before purchasing a plan.", "LOGIN_REQUIRED");
            output = { order: await this.createOrder(account, body) }; break;
          }
          case "access/grace": throw new MarketError(409, "Hourly access and grace have been replaced by per-send access. Refresh this page.", "POLICY_CHANGED");
          case "sends/prepare": output = await (await this.sendService(account)).prepare(body.intent); break;
          case "sends/no-fill": output = await (await this.sendService(account)).noFill(body.operationId, body.reason); break;
          case "sends/commit": output = { sendAccess: await (await this.sendService(account)).commit(body.operationId, body.status) }; break;
          case "usage/sync": output = await (await this.sendService(account)).sync(body.events); break;
          case "ads/start": {
            await this.limit(`ad:${this.assertion!.device.installationId}`, 120, 60 * 60_000);
            output = await (await this.sendService(account)).startAd(body.purpose, body.operationId); break;
          }
          case "ads/complete": {
            await (await this.sendService(account)).completeAd(body.attemptId);
            output = await this.state(account); break;
          }
          default: {
            const refund = /^orders\/([^/]+)\/refund$/.exec(path);
            if (refund) {
              this.development(); if (!account) throw new MarketError(401, "Sign in to test a duplicate-charge refund.", "LOGIN_REQUIRED");
              const order = await this.order(refund[1], account);
              await this.refundDemoDuplicate(order, account);
              output = { order: publicOrder(await this.order(order.id, account)) }; break;
            }
            const demo = /^orders\/([^/]+)\/demo$/.exec(path);
            if (!demo) throw new MarketError(404, "This action does not exist.", "NOT_FOUND");
            this.development(); if (!account) throw new MarketError(401, "Sign in to test a purchase.", "LOGIN_REQUIRED");
            const order = await this.order(demo[1], account); if (order.provider !== "demo") throw new MarketError(403, "This is not a demo order.", "INVALID_ORDER");
            if (body.outcome === "paid") await this.grantPayment(order.id, `demo:${order.id}`, order.amount_paise, "INR", "demo");
            else if (body.outcome === "failed") await this.db.prepare("UPDATE market_orders SET status='failed' WHERE id=? AND status='pending'").bind(order.id).run();
            else throw new MarketError(400, "Choose a demo payment result.", "INVALID_OUTCOME");
            output = { order: publicOrder(await this.order(order.id, account)) };
          }
        }
      }
      return this.respond(output);
    } catch (error) {
      return this.respond({ error: error instanceof ApiError ? error.message : "Account services are temporarily unavailable. Try again shortly.", ...(error instanceof MarketError || error instanceof SendPolicyError ? { code: error.code } : {}) }, error instanceof ApiError ? error.status : 503);
    }
  }
  private respond(value: unknown, status = 200): Response {
    const headers = new Headers({ "Cache-Control": "no-store, private", "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    for (const cookie of this.responseCookies) headers.append("Set-Cookie", cookie);
    return new Response(JSON.stringify(value), { status, headers });
  }
}
export function requireMarketOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site" || !(request.headers.get("content-type") || "").startsWith("application/json")) throw new MarketError(403, "Open account actions from the sharing website.", "INVALID_ORIGIN");
}
async function boundedText(request: Request, max: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > max) throw new ApiError(413, "Payment event is too large.");
  if (!request.body) return "";
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > max) { await reader.cancel(); throw new ApiError(413, "Payment event is too large."); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  const data = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(data);
}
