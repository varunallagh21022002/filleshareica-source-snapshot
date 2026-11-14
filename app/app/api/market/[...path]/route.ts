import { env } from "cloudflare:workers";
import { MarketService, marketConfig, type MarketEnvironment } from "@/lib/server/market";

async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/api\/market\//, "").replace(/\/$/, "");
  const marketEnv = env as Cloudflare.Env & MarketEnvironment;
  if (path === "config" && request.method === "GET") return Response.json(marketConfig(marketEnv, request), { headers: { "Cache-Control": "no-store" } });
  if (!env.DB) return Response.json({ error: "The account database is not configured.", code: "DATABASE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return new MarketService(env.DB, marketEnv, request).dispatch(path);
}
export const GET = handle;
export const POST = handle;
