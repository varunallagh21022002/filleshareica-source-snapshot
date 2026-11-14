import { apiResponse, clientAddress, mutationBody, type RouteContext } from "@/lib/server/http";
import { groupService } from "@/lib/server/group-http";

export async function POST(request: Request, context: RouteContext) {
  return apiResponse(async () => groupService().join((await context.params).id, await mutationBody(request), clientAddress(request)), 201);
}
