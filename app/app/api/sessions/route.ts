import { apiResponse, clientAddress, mutationBody, service } from "@/lib/server/http";

export async function POST(request: Request) {
  return apiResponse(async () => service().create(await mutationBody(request), clientAddress(request)), 201);
}
