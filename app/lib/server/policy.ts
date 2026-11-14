export type SessionRole = "host" | "guest";
export type SessionStatus = "waiting" | "pending" | "approved" | "rejected" | "closed";

export const INVITE_TTL_MS = 10 * 60_000;
export const IDLE_TTL_MS = 30 * 60_000;
export const MAX_SIGNAL_BYTES = 96 * 1024;
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_QUEUED_SIGNALS = 512;

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateDeviceName(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "A device name is required.");
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 60) throw new ApiError(400, "Use a device name between 1 and 60 characters.");
  return name;
}

export function validateSessionName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiError(400, "Use a session name of up to 40 characters.");
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length > 40) throw new ApiError(400, "Use a session name of up to 40 characters.");
  return name || null;
}

export function sessionSlug(_name: string | null): string {
  void _name; // Keep the legacy call signature; invitation addresses use random codes.
  return randomToken().slice(0, 6);
}

export function validateSessionIdentifier(value: string): void {
  if (/^[a-f0-9]{6}$/.test(value)) return;
  if (/^[a-z0-9](?:[a-z0-9-]{0,31})-[a-f0-9]{6}$/.test(value)) return;
  validateSessionId(value);
}

export function validateConnectionRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ApiError(400, "Invalid connection revision.");
  return value as number;
}

export function validateJoinHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new ApiError(400, "The connection link is invalid.");
  }
  return value.toLowerCase();
}

export function validateSessionId(value: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw new ApiError(404, "This connection link is unavailable or expired.");
  }
}

export function parseCursor(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d{1,16}$/.test(value)) throw new ApiError(400, "Invalid signaling cursor.");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new ApiError(400, "Invalid signaling cursor.");
  return cursor;
}

export function validatePayload(value: unknown): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > MAX_SIGNAL_BYTES) {
    throw new ApiError(413, "The encrypted signaling message is too large or empty.");
  }
  return value;
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "Open this connection from the sharing website.");
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "Request body is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body");
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Send a valid JSON object.");
  }
}
