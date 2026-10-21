import { type Job, type Queue } from "bullmq";
import { config } from "../../../../shared/config.js";
import { listPlannableSeats, runPlanSeat } from "../../../../shared/planner/run.js";
import { createUnipile } from "../../../../shared/providers/unipile.js";
import { database } from "../db.js";
import { planJobId, retention } from "../queues.js";

export async function planFanout(plan: Queue): Promise<number> {
  const seats = await listPlannableSeats(database().sql);
  for (const seat of seats) {
    const jobId = planJobId(seat.id);
    const existing = await plan.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") await existing.remove();
      else continue;
    }
    await plan.add("seat", seat, { jobId, attempts: 2, ...retention });
  }
  return seats.length;
}

export async function planSeat(job: Job<{ id: string; kind: "linkedin" | "email" }>): Promise<void> {
  const vendor = createUnipile();
  await runPlanSeat(database().sql, job.data.id, job.data.kind, vendor);
}

export const planConcurrency = config.queues.plan;
