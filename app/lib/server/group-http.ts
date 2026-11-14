import { env } from "cloudflare:workers";
import { ApiError } from "./policy";
import { GroupService } from "./groups";

export function groupService(): GroupService {
  if (!env.DB) throw new ApiError(503, "The connection database is not configured. Start the project with its D1 database binding.");
  return new GroupService(env.DB);
}
