import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { actions, contacts, jobRequests } from "../db/schema.js";
import { forOrg } from "../db/scope.js";
import { checkMessage } from "../message-check.js";

export interface ManualSendPayload {
  contactId?: string;
  channel?: "linkedin" | "email";
  body?: string;
  subject?: string;
  linkedinSeatId?: string;
  emailSeatId?: string;
  actionId?: string;
}

/** Inbox replies are created as sending immediately. That is the exception to one-action-at-a-time. */
export async function queueManualReply(db: Database, orgId: string, input: {
  contactId: string;
  channel: "linkedin" | "email";
  body: string;
  subject?: string;
  linkedinSeatId?: string | null;
  emailSeatId?: string | null;
  language?: string;
}): Promise<{ jobId: string } | { error: string }> {
  const [contact] = await db.select().from(contacts).where(and(forOrg(orgId, contacts.orgId), eq(contacts.id, input.contactId))).limit(1);
  if (!contact) return { error: "Contact not found" };
  const check = checkMessage({
    kind: input.channel === "email" ? "email" : "message",
    body: input.body,
    subject: input.subject,
    language: input.language ?? "en",
  });
  if (!check.ok) return { error: check.reason };
  const [job] = await db.insert(jobRequests).values({
    orgId,
    type: "manual_send",
    status: "pending",
    payload: {
      contactId: input.contactId,
      channel: input.channel,
      body: input.body,
      subject: input.subject ?? null,
      linkedinSeatId: input.linkedinSeatId ?? null,
      emailSeatId: input.emailSeatId ?? null,
    },
  }).returning();
  if (!job) return { error: "Could not queue the reply" };
  return { jobId: job.id };
}

export async function handleManualSend(
  db: Database,
  orgId: string,
  payload: unknown,
  enqueue?: (actionId: string) => Promise<void>,
  jobId?: string,
): Promise<{ actionId: string }> {
  const body = (payload ?? {}) as ManualSendPayload;
  if (!enqueue) throw new Error("Send queue is not configured");
  if (body.actionId) {
    await enqueue(body.actionId);
    return { actionId: body.actionId };
  }
  if (!body.contactId || !body.body || !body.channel) throw new Error("Manual send is missing a contact or a message");
  const check = checkMessage({
    kind: body.channel === "email" ? "email" : "message",
    body: body.body,
    subject: body.subject,
    language: "en",
  });
  if (!check.ok) throw new Error(check.reason);
  const linkedinSeatId = body.channel === "linkedin" ? body.linkedinSeatId ?? null : null;
  const emailSeatId = body.channel === "email" ? body.emailSeatId ?? null : null;
  if (!linkedinSeatId && !emailSeatId) throw new Error("Manual send needs a seat");
  const [action] = await db.insert(actions).values({
    orgId,
    contactId: body.contactId,
    campaignStepId: null,
    source: "manual",
    type: body.channel === "email" ? "email" : "message",
    linkedinSeatId,
    emailSeatId,
    content: body.body,
    subject: body.subject ?? null,
    status: "sending",
    claimedAt: new Date(),
    scheduledFor: new Date(),
  }).returning();
  if (!action) throw new Error("Reply action was not created");
  const nextPayload: ManualSendPayload = { ...body, actionId: action.id };
  if (jobId) {
    await db.update(jobRequests).set({ payload: nextPayload }).where(eq(jobRequests.id, jobId));
  }
  await enqueue(action.id);
  return { actionId: action.id };
}
