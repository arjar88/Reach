import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { createDb, type Database } from "../../../shared/db/client.js";
import { createClaude } from "../../../shared/providers/claude.js";
import { createResend } from "../../../shared/providers/resend.js";
import { createUnipile } from "../../../shared/providers/unipile.js";
import { startEnrichWorker } from "./jobs/enrich.js";
import { enqueueManualSend, startEventsWorker } from "./jobs/events.js";
import { createQueues, PLAN_QUEUE, RECONCILE_QUEUE, SEND_QUEUE, retention } from "./queues.js";
import { useDatabase } from "./db.js";
import { assertNoEviction, createRedis } from "./redis.js";
import { startRuntime } from "./runtime.js";
import { registerDailyScheduler, startDailyWorker } from "./ticks/daily.js";
import { planConcurrency, planFanout, planSeat } from "./ticks/plan.js";
import { reconcileTick } from "./ticks/reconcile.js";
import { claimTick, sendAction, sendConcurrency } from "./ticks/sender.js";

export { fanoutSignalIds } from "./fanout.js";
export { assertNoEviction, createRedis } from "./redis.js";
export { startRuntime, registerTickSchedulers, handleTick } from "./runtime.js";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function invokedDirectly(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("/index.ts") || entry.endsWith("/index.js") || entry.endsWith("\\index.js");
}

function duplicate(redis: Redis, links: Redis[]): ConnectionOptions {
  const next = redis.duplicate();
  links.push(next);
  return next as unknown as ConnectionOptions;
}

/**
 * Sender plan/send/reconcile ticks plus inbox events, daily, and enrich.
 * Phase 1 queue tests call startRuntime directly and leave these workers off.
 */
export async function startProductWorkers(redis: Redis, db: Database, sql: Sql) {
  const links: Redis[] = [];
  const queueRedis = redis.duplicate();
  links.push(queueRedis);
  const queues = createQueues(queueRedis);
  const dailyQueue = new Queue("daily", { connection: duplicate(redis, links) });

  await queues.plan.upsertJobScheduler("plan-hourly", { every: HOUR }, {
    name: "fanout",
    opts: { attempts: 2, ...retention },
  });
  await queues.send.upsertJobScheduler("send-minute", { every: MINUTE }, {
    name: "claim",
    opts: { attempts: 0, ...retention },
  });
  await queues.reconcile.upsertJobScheduler("reconcile-10m", { every: 10 * MINUTE }, {
    name: "reconcile",
    opts: { attempts: 2, ...retention },
  });
  await registerDailyScheduler(dailyQueue);

  const workers: Worker[] = [
    new Worker(PLAN_QUEUE, async (job) => {
      if (job.name === "fanout") return planFanout(queues.plan);
      return planSeat(job);
    }, { connection: duplicate(redis, links), concurrency: planConcurrency }),
    new Worker(SEND_QUEUE, async (job) => {
      if (job.name === "claim") return claimTick(queues.send);
      return sendAction(job);
    }, { connection: duplicate(redis, links), concurrency: sendConcurrency }),
    new Worker(RECONCILE_QUEUE, async () => reconcileTick(), { connection: duplicate(redis, links), concurrency: 1 }),
    startEventsWorker(duplicate(redis, links), db, {
      sql,
      claude: process.env.ANTHROPIC_API_KEY ? createClaude() : undefined,
      resend: process.env.RESEND_API_KEY ? createResend() : undefined,
      enqueueSend: (actionId) => enqueueManualSend(queues.send, actionId),
    }),
    startDailyWorker(duplicate(redis, links), db, sql, {
      unipile: process.env.UNIPILE_API_KEY ? createUnipile() : undefined,
      resend: process.env.RESEND_API_KEY ? createResend() : undefined,
    }),
    startEnrichWorker(duplicate(redis, links), db, sql),
  ];

  return {
    async shutdown() {
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all([
        queues.plan.close(),
        queues.send.close(),
        queues.reconcile.close(),
        dailyQueue.close(),
      ]);
      for (const link of links) link.disconnect();
    },
  };
}

export async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_SESSION;
  if (!url) throw new Error("DATABASE_URL_SESSION is not set");
  const redis = createRedis();
  await assertNoEviction(redis);
  const opened = createDb(url, "worker");
  useDatabase(opened);
  const { db, sql } = opened;
  const runtime = await startRuntime({ redis, sql, db });
  const product = await startProductWorkers(redis, db, sql);
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await product.shutdown();
    await runtime.shutdown();
    await sql.end({ timeout: 5 });
    redis.disconnect();
  };
  process.once("SIGTERM", () => {
    shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  process.once("SIGINT", () => {
    shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "worker failed");
    process.exit(1);
  });
}
