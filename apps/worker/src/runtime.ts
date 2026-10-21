import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { claimJobRequests, releaseJobRequest, touchHeartbeat } from "../../../shared/db/outbox.js";
import type { Database } from "../../../shared/db/client.js";
import type { Sql } from "postgres";
import { liveJobDeps, type JobDeps } from "./jobs/deps.js";
import { runClaimedJob } from "./jobs/onboarding.js";

export const TICK_QUEUE = "reach-ticks";
export const EVENT_QUEUE = "reach-events";

export const jobRetention = {
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 604_800 },
};

const tickSpecs: { id: string; name: string; every?: number; pattern?: string; tz?: string }[] = [
  { id: "outbox", name: "outbox", every: 5_000 },
  { id: "sender", name: "sender", every: 60_000 },
  { id: "signals", name: "signals", every: 600_000 },
  { id: "plan", name: "plan", every: 3_600_000 },
  { id: "reconcile", name: "reconcile", every: 600_000 },
  { id: "health", name: "health", every: 300_000 },
  { id: "daily", name: "daily", pattern: "0 3 * * *", tz: "UTC" },
];

export async function registerTickSchedulers(queue: Queue): Promise<void> {
  for (const spec of tickSpecs) {
    const repeat = spec.pattern ? { pattern: spec.pattern, tz: spec.tz } : { every: spec.every ?? 60_000 };
    await queue.upsertJobScheduler(spec.id, repeat, {
      name: spec.name,
      data: {},
      opts: jobRetention,
    });
  }
}

export async function handleTick(name: string, ctx: {
  sql: Sql;
  db: Database;
  events: Queue;
  deps: JobDeps;
}): Promise<void> {
  if (name === "health") {
    await touchHeartbeat(ctx.sql, { tick: "health" });
    return;
  }
  if (name !== "outbox") return;
  const claimed = await claimJobRequests(ctx.sql);
  for (const row of claimed) {
    try {
      await ctx.events.add(row.type, { id: row.id }, {
        deduplication: { id: `job-${row.id}` },
        attempts: row.type === "manual_send" || row.type === "start_sequences" ? 1 : 5,
        backoff: { type: "exponential", delay: 1_000 },
        ...jobRetention,
      });
    } catch (error) {
      await releaseJobRequest(ctx.sql, row.id);
      throw error;
    }
  }
}

export interface Runtime {
  ticks: Queue;
  events: Queue;
  workers: Worker[];
  shutdown(): Promise<void>;
}

export async function startRuntime(opts: {
  redis: Redis;
  sql: Sql;
  db: Database;
  deps?: JobDeps;
  registerSchedulers?: boolean;
  tickQueue?: string;
  eventQueue?: string;
}): Promise<Runtime> {
  const connection = opts.redis as unknown as ConnectionOptions;
  const tickName = opts.tickQueue ?? TICK_QUEUE;
  const eventName = opts.eventQueue ?? EVENT_QUEUE;
  const ticks = new Queue(tickName, { connection });
  const events = new Queue(eventName, { connection: opts.redis.duplicate() as unknown as ConnectionOptions });
  const deps = opts.deps ?? liveJobDeps();
  const ctx = { sql: opts.sql, db: opts.db, events, deps };
  if (opts.registerSchedulers !== false) await registerTickSchedulers(ticks);
  const tickWorker = new Worker(tickName, async (job: Job) => {
    await handleTick(job.name, ctx);
  }, { connection: opts.redis.duplicate() as unknown as ConnectionOptions, concurrency: 1 });
  const eventWorker = new Worker(eventName, async (job: Job) => {
    const id = typeof job.data?.id === "string" ? job.data.id : "";
    if (!id) return;
    await runClaimedJob(opts.db, opts.sql, id, deps);
  }, { connection: opts.redis.duplicate() as unknown as ConnectionOptions, concurrency: 20 });
  const workers = [tickWorker, eventWorker];
  return {
    ticks,
    events,
    workers,
    async shutdown() {
      await Promise.all(workers.map((worker) => worker.close()));
      await events.close();
      await ticks.close();
    },
  };
}
