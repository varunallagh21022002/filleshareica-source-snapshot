import { apiResponse, bearerToken, type RouteContext } from "@/lib/server/http";
import { groupService } from "@/lib/server/group-http";

export async function GET(request: Request, context: RouteContext) {
  return apiResponse(async () => groupService().poll((await context.params).id, bearerToken(request)));
}
