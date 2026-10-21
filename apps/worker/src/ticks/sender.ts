import type { Job, Queue } from "bullmq";
import { config } from "../../../../shared/config.js";
import { runStartSequences } from "../../../../shared/planner/start.js";
import { createUnipile } from "../../../../shared/providers/unipile.js";
import { claimDueActions } from "../../../../shared/sender/claim.js";
import { runSendAction } from "../../../../shared/sender/persist.js";
import { database } from "../db.js";
import { retention, sendJobId } from "../queues.js";

/** Claim one due action per seat, then enqueue a send job that does not retry. */
export async function claimTick(send: Queue): Promise<number> {
  const sql = database().sql;
  await runStartSequences(sql);
  const ids = await claimDueActions(sql);
  for (const actionId of ids) {
    const jobId = sendJobId(actionId);
    const existing = await send.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") await existing.remove();
      else continue;
    }
    await send.add("send", { actionId }, { jobId, attempts: 0, ...retention });
  }
  return ids.length;
}

export async function sendAction(job: Job<{ actionId: string }>): Promise<void> {
  await runSendAction(database().sql, job.data.actionId, createUnipile());
}

export const sendConcurrency = config.queues.send;
