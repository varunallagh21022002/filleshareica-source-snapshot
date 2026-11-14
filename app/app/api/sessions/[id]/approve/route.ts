import { apiResponse, bearerToken, mutationBody, service, type RouteContext } from "@/lib/server/http";

export async function POST(request: Request, context: RouteContext) {
  return apiResponse(async () => service().approve((await context.params).id, bearerToken(request), (await mutationBody(request)).accept));
}
