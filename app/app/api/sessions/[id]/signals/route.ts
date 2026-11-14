import { apiResponse, bearerToken, mutationBody, service, type RouteContext } from "@/lib/server/http";

export async function POST(request: Request, context: RouteContext) {
  return apiResponse(async () => {
    const body = await mutationBody(request);
    return service().signal((await context.params).id, bearerToken(request), body.payload, body.connectionRevision);
  }, 201);
}
