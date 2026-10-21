import { Queue, Worker } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { claimJobRequests, readHeartbeat } from "../../../shared/db/outbox.js";
import { jobRequests } from "../../../shared/db/schema.js";
import { insertOrg, resetTables, testDatabase } from "../../../shared/db/test-support.js";
import { handleTick, jobRetention } from "./runtime.js";
import { assertNoEviction, createRedis } from "./redis.js";
import { liveJobDeps } from "./jobs/deps.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await sleep(50);
  }
  return pred();
}

describe("queues", () => {
  const redis = createRedis();

  afterAll(async () => {
    redis.disconnect();
    const conn = await testDatabase();
    await conn.sql.end({ timeout: 1 });
  });

  it("refuses a Redis policy other than noeviction", async () => {
    const probe = createRedis();
    const prior = await probe.call("CONFIG", "GET", "maxmemory-policy");
    const previous = Array.isArray(prior) ? String(prior[1] ?? "noeviction") : "noeviction";
    try {
      await probe.call("CONFIG", "SET", "maxmemory-policy", "volatile-lru");
      await expect(assertNoEviction(probe)).rejects.toThrow(/noeviction/);
      const blind = {
        call: async () => {
          throw new Error("denied");
        },
      };
      await expect(assertNoEviction(blind as unknown as typeof probe)).rejects.toThrow(/could not be read/);
    } finally {
      await probe.call("CONFIG", "SET", "maxmemory-policy", previous);
      probe.disconnect();
    }
  });

  it("blocks a duplicate while the job is open and accepts it after", async () => {
    const name = `reach-dedupe-${crypto.randomUUID()}`;
    const queue = new Queue(name, { connection: redis.duplicate() });
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const worker = new Worker(name, async () => {
      started += 1;
      await hold;
    }, { connection: redis.duplicate(), concurrency: 1 });
    const id = "dedupe-row";
    try {
      await queue.add("work", { n: 1 }, { deduplication: { id } });
      await queue.add("work", { n: 2 }, { deduplication: { id } });
      const open = await queue.getJobCounts("waiting", "paused", "delayed", "prioritized", "active");
      const openCount = (open.waiting ?? 0) + (open.paused ?? 0) + (open.delayed ?? 0) + (open.prioritized ?? 0) + (open.active ?? 0);
      expect(openCount).toBe(1);
      const opened = await waitFor(() => started === 1, 5_000);
      expect(opened).toBe(true);
      release();
      const finished = await waitFor(async () => (await queue.getJobCounts("completed")).completed === 1, 5_000);
      expect(finished).toBe(true);
      await queue.add("work", { n: 3 }, { deduplication: { id } });
      const again = await waitFor(() => started === 2, 5_000);
      expect(again).toBe(true);
    } finally {
      release();
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("runs one scheduler once across two workers", async () => {
    const name = `reach-sched-${crypto.randomUUID()}`;
    const queue = new Queue(name, { connection: redis.duplicate() });
    let processed = 0;
    const workers = [0, 1].map(() => new Worker(name, async () => {
      processed += 1;
    }, { connection: redis.duplicate(), concurrency: 1 }));
    try {
      await queue.upsertJobScheduler("once", { every: 400 }, { name: "tick", data: {}, opts: jobRetention });
      await queue.upsertJobScheduler("once", { every: 400 }, { name: "tick", data: {}, opts: jobRetention });
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers.filter((row) => row.id === "once" || row.key === "once" || row.name === "once").length).toBeLessThanOrEqual(1);
      expect(schedulers.length).toBe(1);
      const started = await waitFor(() => processed >= 1, 8_000);
      expect(started).toBe(true);
      const mark = Date.now();
      const atMark = processed;
      await sleep(2_000);
      const delta = processed - atMark;
      const intervals = (Date.now() - mark) / 400;
      expect(delta).toBeGreaterThanOrEqual(1);
      expect(delta).toBeLessThan(intervals * 1.6);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("processes an outbox row to done and records a heartbeat", async () => {
    const { db, sql } = await testDatabase();
    await resetTables(sql);
    const orgId = await insertOrg(sql, "Outbox");
    await db.insert(jobRequests).values({ orgId, type: "manual_send", payload: {}, status: "pending" });
    const name = `reach-events-${crypto.randomUUID()}`;
    const events = new Queue(name, { connection: redis.duplicate() });
    const worker = new Worker(name, async (job) => {
      const { runClaimedJob } = await import("./jobs/onboarding.js");
      await runClaimedJob(db, sql, String(job.data.id), liveJobDeps());
    }, { connection: redis.duplicate() });
    try {
      await handleTick("outbox", { sql, db, events, deps: liveJobDeps() });
      const done = await waitFor(async () => {
        const rows = await sql<{ status: string; result: { acked?: boolean } | null }[]>`
          SELECT status, result FROM job_requests WHERE org_id = ${orgId}
        `;
        return rows[0]?.status === "done" && rows[0]?.result?.acked === true;
      }, 8_000);
      expect(done).toBe(true);
      const still = await claimJobRequests(sql);
      expect(still).toHaveLength(0);
      await handleTick("health", { sql, db, events, deps: liveJobDeps() });
      const beat = await readHeartbeat(sql);
      expect(beat).toBeInstanceOf(Date);
      await handleTick("sender", { sql, db, events, deps: liveJobDeps() });
    } finally {
      await worker.close();
      await events.obliterate({ force: true });
      await events.close();
    }
  });

  it("closes workers on shutdown", async () => {
    const { db, sql } = await testDatabase();
    const name = `reach-stop-${crypto.randomUUID()}`;
    const { startRuntime } = await import("./runtime.js");
    const runtime = await startRuntime({
      redis,
      sql,
      db,
      deps: liveJobDeps(),
      registerSchedulers: false,
      tickQueue: `${name}-ticks`,
      eventQueue: `${name}-events`,
    });
    const started = await waitFor(() => runtime.workers.every((worker) => worker.isRunning()), 3_000);
    expect(started).toBe(true);
    await runtime.shutdown();
    const stopped = await waitFor(() => runtime.workers.every((worker) => !worker.isRunning()), 3_000);
    expect(stopped).toBe(true);
    await runtime.ticks.obliterate({ force: true }).catch(() => undefined);
    await runtime.events.obliterate({ force: true }).catch(() => undefined);
  });
});
