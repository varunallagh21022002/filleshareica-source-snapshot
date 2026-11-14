export type PlanId = 'month' | 'six_months' | 'year';
export type DeviceClass = 'desktop' | 'mobile';
export type AccessKind = 'none' | 'ad' | 'grace' | 'paid';
export interface Plan { id: PlanId; name: string; amountPaise: number; months: number; }
export interface DeviceIdentity { installationId: string; deviceClass: DeviceClass; label: string; publicKey: JsonWebKey; }
export interface DeviceAssertion { device: DeviceIdentity; timestamp: number; nonce: string; signature: string; }
export interface PublicAccount { id: string; name: string; email: string; }
export interface RegisteredDevice { id: string; deviceClass: DeviceClass; label: string; installationId: string; createdAt: number; lastSeenAt: number; revokedAt: number | null; }
export interface PublicOrder { id: string; planId: PlanId; amountPaise: number; currency: 'INR'; status: 'pending' | 'paid' | 'failed' | 'refunded'; createdAt: number; paidAt: number | null; provider: 'demo' | 'cashfree'; checkoutSessionId?: string; checkoutUrl?: string; }
export interface MarketConfig { advertisingPolicyVersion?: 2; development: boolean; googleClientId: string | null; paymentMode: 'disabled' | 'demo' | 'sandbox' | 'live'; adsMode: 'disabled' | 'demo'; publisherId: string | null; supportEmail: string | null; publicKey: JsonWebKey | null; issuer: string; plans: Plan[]; }
export interface AccessClaims { iss: string; v: 1; installationId: string; keyThumbprint: string; kind: AccessKind; hyperSpeed: boolean; iat: number; exp: number; paidUntil: number | null; }
export interface AccessState { sendAccess?: SendAccessSummary; kind: AccessKind; allowed: boolean; hyperSpeed: boolean; expiresAt: number | null; paidUntil: number | null; serverNow: number; proof: string | null; deviceStatus: 'guest' | 'registered' | 'unregistered' | 'replacement_required'; account: PublicAccount | null; devices: RegisteredDevice[]; orders: PublicOrder[]; config: MarketConfig; }
export interface MarketError { error: string; code?: string; }
import type { SendAccessSummary } from './send-types';
