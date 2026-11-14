import { apiResponse, bearerToken, service, type RouteContext } from "@/lib/server/http";
import { parseCursor } from "@/lib/server/policy";

export async function GET(request: Request, context: RouteContext) {
  return apiResponse(async () => service().poll((await context.params).id, bearerToken(request), parseCursor(new URL(request.url).searchParams.get("after"))));
}
