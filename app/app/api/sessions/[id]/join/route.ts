import { apiResponse, clientAddress, mutationBody, service, type RouteContext } from "@/lib/server/http";

export async function POST(request: Request, context: RouteContext) {
  return apiResponse(async () => service().join((await context.params).id, await mutationBody(request), clientAddress(request)), 201);
}
