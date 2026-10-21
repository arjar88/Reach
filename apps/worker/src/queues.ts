import { Queue, type JobsOptions, type QueueOptions } from "bullmq";
import type { Redis } from "ioredis";

export const PLAN_QUEUE = "plan";
export const SEND_QUEUE = "send";
export const RECONCILE_QUEUE = "reconcile";

export const retention: Pick<JobsOptions, "removeOnComplete" | "removeOnFail"> = {
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 604_800 },
};

export function planJobId(seatId: string): string {
  return `plan-${seatId}`;
}

export function sendJobId(actionId: string): string {
  return `send-${actionId}`;
}

export function createQueues(connection: Redis): { plan: Queue; send: Queue; reconcile: Queue } {
  const options: QueueOptions = { connection };
  return {
    plan: new Queue(PLAN_QUEUE, options),
    send: new Queue(SEND_QUEUE, options),
    reconcile: new Queue(RECONCILE_QUEUE, options),
  };
}
