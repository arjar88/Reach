import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Sql } from "postgres";
import type { Database } from "../../../../shared/db/client.js";
import { runDailyTick, type DailyDeps } from "../../../../shared/inbox/daily.js";

export const DAILY_QUEUE = "daily";
export const DAILY_PATTERN = "0 3 * * *";

export async function registerDailyScheduler(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler("daily", { pattern: DAILY_PATTERN, tz: "UTC" }, { name: "daily" });
}

export function startDailyWorker(connection: ConnectionOptions, db: Database, sql: Sql, deps: DailyDeps = {}): Worker {
  return new Worker(DAILY_QUEUE, async () => {
    await runDailyTick(db, sql, deps);
  }, { connection, concurrency: 1 });
}
