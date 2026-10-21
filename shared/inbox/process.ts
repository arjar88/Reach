import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { actions, contacts, emailSeats, linkedinSeats, organizations, threadMessages, threads, users, webhookEvents } from "../db/schema.js";
import { forOrg } from "../db/scope.js";
import { isAutoReply, isBounce, isOwnerSender } from "./match.js";
import { addThreadMessage, applyEffects, ensureThread, loadSteps, saveSnap, toSnap } from "./persist.js";
import { parseUnipileWebhook, type NormalizedWebhook } from "../providers/unipile.js";
import { onAccepted, onBounce, onReply } from "../sequence.js";
import { createCrmNote } from "../providers/crm.js";
import { postSlack } from "../providers/slack.js";
import type { ResendClient } from "../providers/resend.js";
import { draftPrompt, labelPrompt } from "../prompts/index.js";
import { draftSchema, labelSchema } from "../prompts/schemas.js";
import type { ModelClient } from "../providers/model.js";
import { applyStripeEvent } from "./billing.js";
import type { Sql } from "postgres";
import { handleManualSend } from "./reply.js";
import { jobRequests } from "../db/schema.js";

export interface ProcessDeps {
  sql: Sql;
  model?: ModelClient;
  resend?: ResendClient;
  enqueueSend?: (actionId: string) => Promise<void>;
  deleteUnipileAccount?: (accountId: string) => Promise<void>;
}

async function clearPayload(db: Database, dedupeKey: string): Promise<void> {
  await db.update(webhookEvents).set({ payload: null, processedAt: new Date() }).where(eq(webhookEvents.dedupeKey, dedupeKey));
}

async function labelThread(db: Database, deps: ProcessDeps, threadId: string, orgId: string, contactEmail: string | null): Promise<void> {
  if (!deps.model) return;
  const history = await db.select().from(threadMessages).where(eq(threadMessages.threadId, threadId)).orderBy(asc(threadMessages.sentAt));
  const recent = history.slice(-5).map((row) => ({ direction: row.direction, content: row.content }));
  const labelPromptParts = labelPrompt({ messages: recent });
  const labeled = await deps.model.json("small", labelPromptParts.system, labelPromptParts.user, labelSchema);
  const draftParts = draftPrompt({ messages: recent, label: labeled.label });
  const draft = await deps.model.json("strong", draftParts.system, draftParts.user, draftSchema);
  await db.update(threads).set({ label: labeled.label, labelReason: labeled.reason, aiDraft: draft.body }).where(eq(threads.id, threadId));
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const text = `New reply (${labeled.label}): ${labeled.reason}`;
  if (org?.slackWebhookUrl) await postSlack(org.slackWebhookUrl, text);
  if (deps.resend) {
    const [owner] = await db.select().from(users).where(and(forOrg(orgId, users.orgId), eq(users.role, "owner"))).limit(1);
    if (owner) await deps.resend.send({ to: owner.email, subject: "New Reach reply", text });
  }
  if (org?.crmProvider && org.crmApiKey && (org.crmProvider === "hubspot" || org.crmProvider === "pipedrive")) {
    await createCrmNote({ provider: org.crmProvider, apiKey: org.crmApiKey, email: contactEmail, body: draft.body });
  }
}

async function processMessage(db: Database, deps: ProcessDeps, orgId: string, event: Extract<NormalizedWebhook, { kind: "message" }>): Promise<void> {
  const attendee = event.attendeeProviderId;
  if (!attendee) return;
  const [contact] = await db.select().from(contacts).where(and(forOrg(orgId, contacts.orgId), eq(contacts.providerId, attendee))).limit(1);
  if (!contact) return;
  const owner = isOwnerSender(event.ownerProviderId, event.senderProviderId);
  const threadId = await ensureThread(db, {
    orgId,
    contactId: contact.id,
    channel: "linkedin",
    externalId: event.chatId ? `linkedin:${event.chatId}` : `linkedin:contact:${contact.id}`,
    at: new Date(event.at),
  });
  await addThreadMessage(db, {
    orgId,
    threadId,
    externalId: event.messageId,
    direction: owner ? "out" : "in",
    content: event.text,
    sentAt: new Date(event.at),
  });
  if (event.chatId && contact.linkedinChatId !== event.chatId) {
    await db.update(contacts).set({ linkedinChatId: event.chatId }).where(eq(contacts.id, contact.id));
  }
  if (owner) return;
  const snap = toSnap(contact);
  const next = onReply(snap);
  await saveSnap(db, next.contact);
  await applyEffects(db, contact.id, next.effects);
  await labelThread(db, deps, threadId, orgId, contact.email);
}

async function processRelation(db: Database, orgId: string, event: Extract<NormalizedWebhook, { kind: "new_relation" }>): Promise<void> {
  const [contact] = await db.select().from(contacts).where(and(
    forOrg(orgId, contacts.orgId),
    eq(contacts.providerId, event.providerId),
  )).limit(1);
  if (!contact) return;
  const steps = await loadSteps(db, contact.campaignId);
  const next = onAccepted(toSnap(contact), steps, event.at);
  await saveSnap(db, next.contact);
}

async function processMail(db: Database, deps: ProcessDeps, orgId: string, event: Extract<NormalizedWebhook, { kind: "mail_received" }>): Promise<void> {
  if (isAutoReply(event.headers)) return;
  let contactId: string | null = null;
  if (event.inReplyTo) {
    const [action] = await db.select().from(actions).where(and(
      forOrg(orgId, actions.orgId),
      eq(actions.emailMessageId, event.inReplyTo),
    )).limit(1);
    contactId = action?.contactId ?? null;
  }
  if (!contactId && event.from) {
    const [contact] = await db.select().from(contacts).where(and(
      forOrg(orgId, contacts.orgId),
      eq(contacts.email, event.from.toLowerCase()),
    )).limit(1);
    contactId = contact?.id ?? null;
  }
  if (!contactId) return;
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!contact) return;
  if (isBounce(event.from, event.subject)) {
    const next = onBounce(toSnap(contact));
    await saveSnap(db, next.contact);
    await applyEffects(db, contact.id, next.effects);
    return;
  }
  const threadId = await ensureThread(db, {
    orgId,
    contactId: contact.id,
    channel: "email",
    externalId: `email:${contact.id}`,
    at: new Date(event.at),
  });
  await addThreadMessage(db, {
    orgId,
    threadId,
    externalId: event.messageId ?? `email-in:${event.at}`,
    direction: "in",
    content: event.body,
    sentAt: new Date(event.at),
  });
  const next = onReply(toSnap(contact));
  await saveSnap(db, next.contact);
  await applyEffects(db, contact.id, next.effects);
  await labelThread(db, deps, threadId, orgId, contact.email);
}

async function processMailSent(db: Database, orgId: string, event: Extract<NormalizedWebhook, { kind: "mail_sent" }>): Promise<void> {
  if (!event.trackingId) return;
  await db.update(actions).set({
    emailMessageId: event.messageId,
    emailProviderId: event.providerId,
  }).where(and(forOrg(orgId, actions.orgId), eq(actions.externalId, event.trackingId)));
}

async function processAccount(db: Database, event: Extract<NormalizedWebhook, { kind: "account_status" }>): Promise<void> {
  const ok = event.status.toUpperCase() === "OK";
  const patch = {
    unipileStatus: event.status,
    statusChangedAt: new Date(event.at),
    pausedReason: ok ? null : event.status,
  };
  await db.update(linkedinSeats).set(patch).where(eq(linkedinSeats.unipileAccountId, event.accountId));
  await db.update(emailSeats).set(patch).where(eq(emailSeats.unipileAccountId, event.accountId));
}

export async function processWebhookEvent(db: Database, dedupeKey: string, deps: ProcessDeps): Promise<void> {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.dedupeKey, dedupeKey)).limit(1);
  if (!row || !row.payload) return;
  if (row.source === "stripe") {
    const body = row.payload as { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
    await applyStripeEvent(db, deps.sql, {
      id: String(body.id ?? ""),
      type: String(body.type ?? ""),
      data: body.data?.object ?? {},
    }, deps);
    await clearPayload(db, dedupeKey);
    return;
  }
  const event = parseUnipileWebhook(row.payload);
  const orgId = row.orgId;
  if (!orgId) {
    await clearPayload(db, dedupeKey);
    return;
  }
  if (event.kind === "message") await processMessage(db, deps, orgId, event);
  else if (event.kind === "new_relation") await processRelation(db, orgId, event);
  else if (event.kind === "mail_received") await processMail(db, deps, orgId, event);
  else if (event.kind === "mail_sent") await processMailSent(db, orgId, event);
  else if (event.kind === "account_status") await processAccount(db, event);
  await clearPayload(db, dedupeKey);
}

export async function processJobRequest(db: Database, jobId: string, deps: ProcessDeps): Promise<void> {
  const [job] = await db.select().from(jobRequests).where(eq(jobRequests.id, jobId)).limit(1);
  if (!job || job.status === "done") return;
  await db.update(jobRequests).set({ status: "running" }).where(eq(jobRequests.id, jobId));
  try {
    if (job.type === "manual_send") {
      const result = await handleManualSend(db, job.orgId, job.payload, deps.enqueueSend, jobId);
      await db.update(jobRequests).set({ status: "done", result, processedAt: new Date(), error: null }).where(eq(jobRequests.id, jobId));
      return;
    }
    await db.update(jobRequests).set({
      status: "failed",
      error: `Unsupported job type ${job.type}`,
      processedAt: new Date(),
    }).where(eq(jobRequests.id, jobId));
  } catch (error) {
    await db.update(jobRequests).set({
      status: "failed",
      error: error instanceof Error ? error.message : "job failed",
      processedAt: new Date(),
    }).where(eq(jobRequests.id, jobId));
    throw error;
  }
}
