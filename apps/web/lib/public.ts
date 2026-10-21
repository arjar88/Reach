import { headers } from "next/headers";
import { config } from "../../../shared/config.js";
import { hitRateLimit } from "../../../shared/inbox/rate-limit.js";
import { getDb } from "./db";

export async function clientIp(): Promise<string> {
  const headerStore = await headers();
  const forwarded = headerStore.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || headerStore.get("x-real-ip") || "local";
}

export async function limitPublic(): Promise<void> {
  const { sql } = getDb();
  const result = await hitRateLimit(sql, `public:${await clientIp()}`, config.rateLimit.publicPerMinute, 60);
  if (!result.allowed) throw new Error("Too many requests. Try again in a minute.");
}
