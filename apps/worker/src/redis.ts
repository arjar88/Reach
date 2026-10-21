import { Redis } from "ioredis";

export function createRedis(url = process.env.REDIS_URL): Redis {
  if (!url) throw new Error("REDIS_URL is not set");
  return new Redis(url, { maxRetriesPerRequest: null });
}

function policyFromReply(reply: unknown): string {
  if (!Array.isArray(reply)) return "";
  const index = reply.findIndex((item) => String(item) === "maxmemory-policy");
  if (index >= 0 && reply[index + 1] != null) return String(reply[index + 1]);
  return reply.length >= 2 ? String(reply[1]) : "";
}

/** Boot refuses anything other than noeviction, including a failed CONFIG GET. */
export async function assertNoEviction(redis: Redis): Promise<void> {
  let reply: unknown;
  try {
    reply = await redis.call("CONFIG", "GET", "maxmemory-policy");
  } catch {
    throw new Error("Redis maxmemory-policy could not be read; refusing to boot");
  }
  const policy = policyFromReply(reply);
  if (policy !== "noeviction") {
    throw new Error(`Redis maxmemory-policy must be noeviction (got ${policy || "empty"})`);
  }
}
