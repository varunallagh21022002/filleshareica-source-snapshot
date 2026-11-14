import { apiResponse, bearerToken, mutationBody, service, type RouteContext } from "@/lib/server/http";

export async function POST(request: Request, context: RouteContext) {
  return apiResponse(async () => {
    await mutationBody(request);
    return service().resume((await context.params).id, bearerToken(request));
  });
}
