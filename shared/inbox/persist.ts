import { and, eq, inArray } from "drizzle-orm";
import type { ContactSnap, Effect, StepRef } from "../sequence.js";
import type { Database } from "../db/client.js";
import { actions, campaignSteps, contacts, threadMessages, threads } from "../db/schema.js";

type ContactRow = typeof contacts.$inferSelect;

export function toSnap(row: ContactRow): ContactSnap {
  return {
    id: row.id,
    status: row.status as ContactSnap["status"],
    campaignId: row.campaignId,
    currentStep: row.currentStep,
    nextStepAt: row.nextStepAt ? row.nextStepAt.toISOString() : null,
    providerId: row.providerId,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    invitedAt: row.invitedAt ? row.invitedAt.toISOString() : null,
    email: row.email,
    emailStatus: row.emailStatus as ContactSnap["emailStatus"],
    emailHiddenAt: row.emailHiddenAt ? row.emailHiddenAt.toISOString() : null,
    rejectedReason: row.rejectedReason,
    finishedReason: row.finishedReason,
    networkDistance: row.networkDistance,
    country: row.country,
  };
}

function at(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

export async function saveSnap(db: Database, snap: ContactSnap, extra: Partial<typeof contacts.$inferInsert> = {}): Promise<void> {
  await db.update(contacts).set({
    status: snap.status,
    campaignId: snap.campaignId,
    currentStep: snap.currentStep,
    nextStepAt: at(snap.nextStepAt),
    providerId: snap.providerId,
    acceptedAt: at(snap.acceptedAt),
    invitedAt: at(snap.invitedAt),
    email: snap.email,
    emailStatus: snap.emailStatus,
    emailHiddenAt: at(snap.emailHiddenAt),
    rejectedReason: snap.rejectedReason,
    finishedReason: snap.finishedReason,
    networkDistance: snap.networkDistance,
    country: snap.country,
    ...extra,
  }).where(eq(contacts.id, snap.id));
}

export async function loadSteps(db: Database, campaignId: string | null): Promise<StepRef[]> {
  if (!campaignId) return [];
  const rows = await db.select().from(campaignSteps).where(eq(campaignSteps.campaignId, campaignId));
  return rows
    .map((row) => ({ position: row.position, type: row.type as StepRef["type"], delayDays: row.delayDays }))
    .sort((a, b) => a.position - b.position);
}

export async function stopOpenActions(db: Database, contactId: string): Promise<void> {
  await db.delete(actions).where(and(
    eq(actions.contactId, contactId),
    inArray(actions.status, ["pending_approval", "ready", "planned"]),
  ));
  await db.update(actions).set({ status: "skipped", error: "stopped" }).where(and(
    eq(actions.contactId, contactId),
    inArray(actions.status, ["sending", "unknown"]),
  ));
}

export async function deleteUnsentActions(db: Database, contactId: string): Promise<void> {
  await db.delete(actions).where(and(
    eq(actions.contactId, contactId),
    inArray(actions.status, ["pending_approval", "ready", "planned"]),
  ));
}

export async function applyEffects(db: Database, contactId: string, effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "stop_open_actions") await stopOpenActions(db, contactId);
    if (effect.type === "delete_unsent_actions") await deleteUnsentActions(db, contactId);
  }
}

export async function ensureThread(db: Database, opts: {
  orgId: string;
  contactId: string;
  channel: "linkedin" | "email";
  externalId: string;
  at: Date;
}): Promise<string> {
  const found = await db.select().from(threads).where(eq(threads.externalId, opts.externalId)).limit(1);
  if (found[0]) return found[0].id;
  const inserted = await db.insert(threads).values({
    orgId: opts.orgId,
    contactId: opts.contactId,
    channel: opts.channel,
    externalId: opts.externalId,
    lastMessageAt: opts.at,
    seen: false,
  }).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0].id;
  const again = await db.select().from(threads).where(eq(threads.externalId, opts.externalId)).limit(1);
  if (!again[0]) throw new Error("Thread was not stored");
  return again[0].id;
}

export async function addThreadMessage(db: Database, opts: {
  orgId: string;
  threadId: string;
  externalId: string;
  direction: "in" | "out";
  content: string;
  sentAt: Date;
}): Promise<boolean> {
  const inserted = await db.insert(threadMessages).values({
    orgId: opts.orgId,
    threadId: opts.threadId,
    externalId: opts.externalId,
    direction: opts.direction,
    content: opts.content,
    sentAt: opts.sentAt,
  }).onConflictDoNothing().returning({ id: threadMessages.id });
  if (inserted.length === 0) return false;
  await db.update(threads).set({ lastMessageAt: opts.sentAt, seen: opts.direction === "out" }).where(eq(threads.id, opts.threadId));
  return true;
}
