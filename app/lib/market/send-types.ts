/** Accounting contains opaque transfer IDs and sizes, never names or file data. */
export const SEND_POLICY_VERSION = 2 as const;
export type SendDecisionKind = 'premium' | 'credit' | 'ad_completed' | 'no_fill' | 'offline';
export interface SendIntent {
  operationId: string;
  sessionId: string;
  manifestDigest: string;
  files: {id: string; size: number}[];
  recipientIds: string[];
  retryOf?: string;
}
export interface SendPermit {
  policyVersion: 2;
  operationId: string;
  sessionId: string;
  manifestDigest: string;
  recipientIds: string[];
  senderInstallationId: string;
  decision: SendDecisionKind;
  issuedAt: number;
  expiresAt: number;
  proof: string | null;
}
export interface SendCredit {id: string; proof: string;}
export interface SendAccessSummary {
  policyVersion: 2;
  creditAvailable: boolean;
  credit: SendCredit | null;
  pendingOfflineAds: number;
  pendingOperationIds?: string[];
  pendingOperationIdsComplete?: boolean;
  strictCatchUp: boolean;
}
export interface PreparedSend {
  operationId: string;
  decision: SendDecisionKind | null;
  permit: SendPermit | null;
  pendingAds: number;
  currentAds: number;
  adsRequired: number;
  sendAccess: SendAccessSummary;
  reservedCredit?: SendCredit | null;
}
export interface OfflineSendEvent {
  operationId: string;
  sessionId: string;
  manifestDigest: string;
  installationId: string;
  verifiedAt: number;
  creditId?: string;
  signature: string;
}
export interface SendMilestone {intent: SendIntent; status: 'verified' | 'released';}
export interface SendRuntime {
  authorize(intent: SendIntent): Promise<SendPermit | null>;
  milestone(event: SendMilestone): Promise<void>;
}
export function sendManifestText(intent: Pick<SendIntent, 'sessionId' | 'files' | 'recipientIds'>): string {
  return JSON.stringify({v: 2, sessionId: intent.sessionId, files: intent.files.map(file => ({id: file.id, size: file.size})), recipientIds: [...intent.recipientIds].sort()});
}
export async function digestSendManifest(intent: Pick<SendIntent, 'sessionId' | 'files' | 'recipientIds'>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sendManifestText(intent))));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}
export function offlineEventText(event: Omit<OfflineSendEvent, 'signature'>): string {
  return JSON.stringify({v: 2, operationId: event.operationId, sessionId: event.sessionId, manifestDigest: event.manifestDigest, installationId: event.installationId, verifiedAt: event.verifiedAt, creditId: event.creditId || null});
}
