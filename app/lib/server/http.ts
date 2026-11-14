import { env } from "cloudflare:workers";
import { ApiError, readBody, requireSameOrigin } from "./policy";
import { SessionService, type SessionEnvironment } from "./sessions";

const headers = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export type RouteContext = { params: Promise<{ id: string }> | { id: string } };

export async function apiResponse(action: () => Promise<unknown>, successStatus = 200): Promise<Response> {
  try {
    return Response.json(await action(), { status: successStatus, headers });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { ...headers, ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) } });
    }
    // Infrastructure errors deliberately exclude SQL, tokens, and payloads.
    return Response.json({ error: "The connection service is temporarily unavailable. Please try again." }, { status: 503, headers });
  }
}

export function service(): SessionService {
  if (!env.DB) throw new ApiError(503, "The connection database is not configured. Start the project with its D1 database binding.");
  return new SessionService(env.DB, env as Cloudflare.Env & SessionEnvironment);
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local-development";
}

export async function mutationBody(request: Request): Promise<Record<string, unknown>> {
  requireSameOrigin(request);
  return readBody(request);
}
