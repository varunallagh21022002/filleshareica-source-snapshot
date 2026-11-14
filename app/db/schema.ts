import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Files never pass through D1. These rows hold only short-lived pairing metadata
// and client-encrypted WebRTC signaling envelopes.
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  sessionName: text("session_name"),
  slug: text("slug"),
  connectionRevision: integer("connection_revision").notNull().default(0),
  joinHash: text("join_hash").notNull(),
  hostTokenHash: text("host_token_hash").notNull(),
  guestTokenHash: text("guest_token_hash"),
  hostName: text("host_name").notNull(),
  guestName: text("guest_name"),
  status: text("status", { enum: ["waiting", "pending", "approved", "rejected", "closed"] }).notNull().default("waiting"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastActiveAt: integer("last_active_at").notNull(),
  hostTurnJson: text("host_turn_json"),
  guestTurnJson: text("guest_turn_json"),
  hostTurnExpiresAt: integer("host_turn_expires_at"),
  guestTurnExpiresAt: integer("guest_turn_expires_at"),
}, (table) => [index("sessions_expiry_idx").on(table.expiresAt), uniqueIndex("sessions_slug_idx").on(table.slug)]);

export const signals = sqliteTable("signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  connectionRevision: integer("connection_revision").notNull().default(0),
  targetRole: text("target_role", { enum: ["host", "guest"] }).notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("signals_session_target_idx").on(table.sessionId, table.targetRole, table.id)]);

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("rate_limits_expiry_idx").on(table.expiresAt)]);

// A group is a small mesh of the same approved, encrypted pair connections.
// No files or chat messages are stored here. Raw child tokens are short-lived
// rendezvous credentials and are returned only to their respective endpoint.
export const groupRooms = sqliteTable("group_rooms", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  sessionName: text("session_name"),
  joinHash: text("join_hash").notNull(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastActiveAt: integer("last_active_at").notNull(),
}, (table) => [uniqueIndex("group_rooms_code_idx").on(table.code), index("group_rooms_expiry_idx").on(table.expiresAt)]);

export const groupMembers = sqliteTable("group_members", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => groupRooms.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  name: text("name").notNull(),
  role: text("role", { enum: ["host", "guest"] }).notNull(),
  status: text("status", { enum: ["pending", "approved", "left", "rejected"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  lastActiveAt: integer("last_active_at").notNull(),
}, (table) => [index("group_members_room_idx").on(table.roomId, table.status), uniqueIndex("group_members_token_idx").on(table.roomId, table.tokenHash)]);

export const groupLinks = sqliteTable("group_links", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id, { onDelete: "cascade" }),
  roomId: text("room_id").notNull().references(() => groupRooms.id, { onDelete: "cascade" }),
  hostMemberId: text("host_member_id").notNull().references(() => groupMembers.id, { onDelete: "cascade" }),
  guestMemberId: text("guest_member_id").notNull().references(() => groupMembers.id, { onDelete: "cascade" }),
  hostToken: text("host_token").notNull(),
  guestToken: text("guest_token").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [uniqueIndex("group_links_pair_idx").on(table.roomId, table.hostMemberId, table.guestMemberId)]);

// Account/billing metadata only. Payment details remain at the checkout provider.
export const marketAccounts = sqliteTable("market_accounts", {
  id: text("id").primaryKey(), googleSubject: text("google_subject").notNull().unique(),
  email: text("email").notNull(), name: text("name").notNull(), createdAt: integer("created_at").notNull(),
  paidUntil: integer("paid_until").notNull().default(0),
});
export const marketInstallations = sqliteTable("market_installations", {
  id: text("id").primaryKey(), keyThumbprint: text("key_thumbprint").notNull(), publicKeyJson: text("public_key_json").notNull(),
  deviceClass: text("device_class").notNull(), label: text("label").notNull(), createdAt: integer("created_at").notNull(),
  adUntil: integer("ad_until").notNull().default(0), graceUntil: integer("grace_until").notNull().default(0), lastGraceAt: integer("last_grace_at").notNull().default(0),
});
export const marketNonces = sqliteTable("market_nonces", {
  id: text("id").primaryKey(), expiresAt: integer("expires_at").notNull(),
}, table => [index("market_nonces_expiry_idx").on(table.expiresAt)]);
export const marketSessions = sqliteTable("market_sessions", {
  tokenHash: text("token_hash").primaryKey(), accountId: text("account_id").notNull().references(() => marketAccounts.id, { onDelete: "cascade" }),
  installationId: text("installation_id").notNull(), authenticatedAt: integer("authenticated_at").notNull(), expiresAt: integer("expires_at").notNull(),
}, table => [index("market_sessions_expiry_idx").on(table.expiresAt)]);
export const marketDevices = sqliteTable("market_devices", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull().references(() => marketAccounts.id, { onDelete: "cascade" }),
  installationId: text("installation_id").notNull(), deviceClass: text("device_class").notNull(), label: text("label").notNull(),
  createdAt: integer("created_at").notNull(), lastSeenAt: integer("last_seen_at").notNull(), revokedAt: integer("revoked_at"),
}, table => [uniqueIndex("market_devices_slot_idx").on(table.accountId, table.deviceClass).where(sql`revoked_at IS NULL`), index("market_devices_account_idx").on(table.accountId)]);
export const marketDeviceChanges = sqliteTable("market_device_changes", {
  id: text("id").primaryKey(), replacedAt: integer("replaced_at").notNull(), operationId: text("operation_id").notNull(),
});
export const marketOrders = sqliteTable("market_orders", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull().references(() => marketAccounts.id),
  planId: text("plan_id").notNull(), amountPaise: integer("amount_paise").notNull(), currency: text("currency").notNull().default("INR"),
  months: integer("months").notNull(), provider: text("provider").notNull(), status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(), paidAt: integer("paid_at"), checkoutSessionId: text("checkout_session_id"),
}, table => [index("market_orders_account_idx").on(table.accountId, table.createdAt), uniqueIndex("market_orders_pending_cashfree_idx").on(table.accountId).where(sql`provider = 'cashfree' AND status = 'pending'`)]);
export const marketPaymentEvents = sqliteTable("market_payment_events", {
  id: text("id").primaryKey(), orderId: text("order_id").notNull().references(() => marketOrders.id), status: text("status").notNull(), createdAt: integer("created_at").notNull(),
});
export const marketGrants = sqliteTable("market_grants", {
  orderId: text("order_id").primaryKey().references(() => marketOrders.id), paymentId: text("payment_id").notNull().unique(),
  accountId: text("account_id").notNull().references(() => marketAccounts.id), createdAt: integer("created_at").notNull(), endsAt: integer("ends_at").notNull(),
});
export const marketAdAttempts = sqliteTable("market_ad_attempts", {
  id: text("id").primaryKey(), installationId: text("installation_id").notNull(), createdAt: integer("created_at").notNull(), readyAt: integer("ready_at").notNull(),
  expiresAt: integer("expires_at").notNull(), completedAt: integer("completed_at"),
  purpose: text("purpose"), operationId: text("operation_id"), completionId: text("completion_id"),
}, table => [index("market_ad_attempts_expiry_idx").on(table.expiresAt)]);
export const marketSendStates = sqliteTable("market_send_states", {
  installationId: text("installation_id").primaryKey(), premiumCutoff: integer("premium_cutoff").notNull().default(0),
});
export const marketSendCredits = sqliteTable("market_send_credits", {
  id: text("id").primaryKey(), installationId: text("installation_id").notNull(), status: text("status").notNull(),
  operationId: text("operation_id"), createdAt: integer("created_at").notNull(), spentAt: integer("spent_at"),
}, table => [uniqueIndex("market_send_one_ready_credit_idx").on(table.installationId).where(sql`status='ready'`), index("market_send_credit_owner_idx").on(table.installationId, table.status)]);
export const marketSendOperations = sqliteTable("market_send_operations", {
  id: text("id").primaryKey(), installationId: text("installation_id").notNull(), operationId: text("operation_id").notNull(),
  sessionId: text("session_id").notNull(), manifestDigest: text("manifest_digest").notNull(), intentJson: text("intent_json"),
  intentHash: text("intent_hash"), decision: text("decision"), creditId: text("credit_id"),
  status: text("status").notNull().default("prepared"), createdAt: integer("created_at").notNull(), verifiedAt: integer("verified_at"), authorizedAt: integer("authorized_at"),
}, table => [uniqueIndex("market_send_operation_owner_idx").on(table.installationId, table.operationId)]);
export const marketOfflineSends = sqliteTable("market_offline_sends", {
  id: text("id").primaryKey(), installationId: text("installation_id").notNull(), operationId: text("operation_id").notNull(),
  sessionId: text("session_id").notNull(), manifestDigest: text("manifest_digest").notNull(), eventHash: text("event_hash").notNull(),
  verifiedAt: integer("verified_at").notNull(), createdAt: integer("created_at").notNull(),
  status: text("status").notNull(), creditId: text("credit_id"), settledAt: integer("settled_at"), settlementId: text("settlement_id"),
}, table => [uniqueIndex("market_offline_send_owner_idx").on(table.installationId, table.operationId), index("market_offline_send_pending_idx").on(table.installationId, table.status, table.verifiedAt)]);
