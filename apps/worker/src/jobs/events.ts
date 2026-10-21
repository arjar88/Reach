import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { config } from "../../../../shared/config.js";
import type { Database } from "../../../../shared/db/client.js";
import { processJobRequest, processWebhookEvent, type ProcessDeps } from "../../../../shared/inbox/process.js";

export const EVENTS_QUEUE = "events";
export const SEND_QUEUE = "send";

export interface EventJob {
  dedupeKey?: string;
  jobRequestId?: string;
}

export function createSendQueue(connection: ConnectionOptions): Queue {
  return new Queue(SEND_QUEUE, { connection });
}

/** Send jobs retry nowhere. The action row is the record of failure. */
export async function enqueueManualSend(queue: Queue, actionId: string): Promise<void> {
  await queue.add("send", { actionId }, {
    deduplication: { id: `send-${actionId}` },
    attempts: 0,
    removeOnComplete: { age: 86_400 },
    removeOnFail: { age: 604_800 },
  });
}

export function startEventsWorker(connection: ConnectionOptions, db: Database, deps: ProcessDeps): Worker {
  return new Worker<EventJob>(EVENTS_QUEUE, async (job) => {
    if (job.data.dedupeKey) await processWebhookEvent(db, job.data.dedupeKey, deps);
    if (job.data.jobRequestId) await processJobRequest(db, job.data.jobRequestId, deps);
  }, { connection, concurrency: config.queues.events });
}
