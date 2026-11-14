import { env } from "cloudflare:workers";
import { apiResponse } from "@/lib/server/http";
import { ApiError } from "@/lib/server/policy";

export async function GET() {
  return apiResponse(async () => {
    if (!env.DB) throw new ApiError(503, "The connection database is not configured.");
    await env.DB.prepare("SELECT id FROM sessions LIMIT 1").first();
    return { status: "ok", service: "fil3shareica", database: "ready" };
  });
}
