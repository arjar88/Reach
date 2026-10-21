"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ContactStatus, EmailStatus } from "../../../../../shared/config.js";
import { forOrg } from "../../../../../shared/db/scope.js";
import { contacts } from "../../../../../shared/db/schema.js";
import { approveLead, rejectLead, type ContactSnap } from "../../../../../shared/sequence.js";
import { requireOrg } from "../org.js";

const CONTACT_STATUSES = new Set<ContactStatus>([
  "pending_review", "approved", "rejected", "in_campaign", "awaiting_acceptance", "replied", "finished", "suppressed",
]);
const EMAIL_STATUSES = new Set<EmailStatus>(["unknown", "found", "not_found", "bounced", "hidden"]);

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function snap(row: typeof contacts.$inferSelect): ContactSnap {
  if (!CONTACT_STATUSES.has(row.status as ContactStatus)) throw new Error(`Unknown lead status ${row.status}`);
  if (!EMAIL_STATUSES.has(row.emailStatus as EmailStatus)) throw new Error(`Unknown email status ${row.emailStatus}`);
  return {
    id: row.id,
    status: row.status as ContactStatus,
    campaignId: row.campaignId,
    currentStep: row.currentStep,
    nextStepAt: iso(row.nextStepAt),
    providerId: row.providerId,
    acceptedAt: iso(row.acceptedAt),
    invitedAt: iso(row.invitedAt),
    email: row.email,
    emailStatus: row.emailStatus as EmailStatus,
    emailHiddenAt: iso(row.emailHiddenAt),
    rejectedReason: row.rejectedReason,
    finishedReason: row.finishedReason,
    networkDistance: row.networkDistance,
    country: row.country,
  };
}

async function load(contactId: string) {
  const { db, orgId } = await requireOrg();
  const [row] = await db.select().from(contacts).where(and(eq(contacts.id, contactId), forOrg(orgId, contacts.orgId))).limit(1);
  if (!row) throw new Error("Lead not found");
  return { db, orgId, row };
}

export async function approveLeadAction(formData: FormData) {
  const contactId = String(formData.get("contactId") ?? "");
  const { db, orgId, row } = await load(contactId);
  const result = approveLead(snap(row));
  if (result.effects.some((effect) => effect.type === "noop")) return;
  if (result.contact.status === row.status) return;
  await db.update(contacts).set({ status: result.contact.status }).where(and(eq(contacts.id, contactId), forOrg(orgId, contacts.orgId)));
  revalidatePath("/leads");
}

export async function rejectLeadAction(formData: FormData) {
  const contactId = String(formData.get("contactId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) throw new Error("A rejection reason is required");
  const { db, orgId, row } = await load(contactId);
  const result = rejectLead(snap(row), reason);
  if (result.effects.some((effect) => effect.type === "noop")) return;
  await db.update(contacts).set({
    status: result.contact.status,
    rejectedReason: result.contact.rejectedReason,
    nextStepAt: result.contact.nextStepAt ? new Date(result.contact.nextStepAt) : null,
  }).where(and(eq(contacts.id, contactId), forOrg(orgId, contacts.orgId)));
  revalidatePath("/leads");
}
