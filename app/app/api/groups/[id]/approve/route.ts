import { apiResponse, bearerToken, mutationBody, type RouteContext } from "@/lib/server/http";
import { groupService } from "@/lib/server/group-http";

export async function POST(request: Request, context: RouteContext) {
  return apiResponse(async () => groupService().approve((await context.params).id, bearerToken(request), await mutationBody(request)));
}
