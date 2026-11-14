import { apiResponse, clientAddress, mutationBody } from "@/lib/server/http";
import { groupService } from "@/lib/server/group-http";

export async function POST(request: Request) {
  return apiResponse(async () => groupService().create(await mutationBody(request), clientAddress(request)), 201);
}
