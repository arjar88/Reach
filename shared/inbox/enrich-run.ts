import { and, eq, sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { config } from "../config.js";
import type { Database } from "../db/client.js";
import { contacts, organizations, users } from "../db/schema.js";
import { forOrg } from "../db/scope.js";
import { canCallVendor } from "../credits.js";
import type { EnrichmentClient } from "../providers/enrichment.js";
import type { ResendClient } from "../providers/resend.js";
import { onEnrichmentFound, onEnrichmentMiss, onNoCredits } from "../sequence.js";
import { debitCredits } from "./credits-db.js";
import { loadSteps, saveSnap, toSnap } from "./persist.js";

export interface EnrichOutcome {
  status: "found" | "not_found" | "hidden" | "duplicate";
  vendorCalls: number;
}

/**
 * Balance is checked before any vendor call. A lost race on the debit becomes hidden
 * and does not leave the balance negative.
 */
export async function enrichContact(db: Database, sqlClient: Sql, contactId: string, deps: {
  enrichment: EnrichmentClient;
  resend?: ResendClient;
  now?: Date;
}): Promise<EnrichOutcome> {
  const nowIso = (deps.now ?? new Date()).toISOString();
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!contact) throw new Error("Contact not found");
  const [org] = await db.select().from(organizations).where(eq(organizations.id, contact.orgId)).limit(1);
  if (!org) throw new Error("Organization not found");
  if (contact.email && contact.emailStatus === "found") return { status: "found", vendorCalls: 0 };
  const paid = await sqlClient<{ id: string }[]>`
    SELECT id FROM credit_ledger WHERE reason = 'enrich' AND ref_id = ${contact.id} LIMIT 1
  `;
  if (paid.length === 0 && !canCallVendor(Number(org.creditsBalance))) {
    const next = onNoCredits(toSnap(contact), nowIso);
    await saveSnap(db, next.contact);
    if (next.effects.some((effect) => effect.type === "notify_owner_once") && deps.resend && !contact.enrichmentNotifiedAt) {
      const [owner] = await db.select().from(users).where(and(forOrg(contact.orgId, users.orgId), eq(users.role, "owner"))).limit(1);
      if (owner) {
        await deps.resend.send({
          to: owner.email,
          subject: "Reach is out of credits",
          text: "Email finding is paused until you add credits.",
        });
        await db.update(contacts).set({ enrichmentNotifiedAt: new Date(nowIso) }).where(eq(contacts.id, contact.id));
      }
    }
    return { status: "hidden", vendorCalls: 0 };
  }

  let vendorCalls = 0;
  const cached = await db.select({ email: contacts.email }).from(contacts).where(and(
    forOrg(contact.orgId, contacts.orgId),
    eq(contacts.profileUrl, contact.profileUrl),
    sql`${contacts.email} IS NOT NULL`,
    sql`${contacts.id} <> ${contact.id}`,
  )).limit(1);
  let email = cached[0]?.email ?? null;
  if (!email) {
    const [first, ...rest] = (contact.name ?? "").split(/\s+/);
    vendorCalls += 1;
    email = await deps.enrichment.findEmail({
      firstName: contact.firstNameClean ?? first ?? null,
      lastName: rest.join(" ") || null,
      company: contact.company,
      domain: null,
    });
  }
  if (!email) {
    const steps = await loadSteps(db, contact.campaignId);
    const next = onEnrichmentMiss(toSnap(contact), steps, nowIso);
    await saveSnap(db, next.contact);
    return { status: "not_found", vendorCalls };
  }
  vendorCalls += 1;
  const deliverable = await deps.enrichment.verify(email);
  if (!deliverable) {
    const steps = await loadSteps(db, contact.campaignId);
    const next = onEnrichmentMiss(toSnap(contact), steps, nowIso);
    await saveSnap(db, next.contact);
    return { status: "not_found", vendorCalls };
  }
  const debit = await debitCredits(sqlClient, contact.orgId, contact.id, 1);
  if (!debit.applied) {
    if (debit.error === "duplicate") {
      const found = onEnrichmentFound(toSnap(contact), email, nowIso);
      await saveSnap(db, found.contact, { emailFoundAt: contact.emailFoundAt ?? new Date(nowIso), enrichmentRequestedAt: null });
      return { status: "duplicate", vendorCalls };
    }
    const hidden = onNoCredits(toSnap(contact), nowIso);
    await saveSnap(db, hidden.contact);
    return { status: "hidden", vendorCalls };
  }
  const found = onEnrichmentFound(toSnap(contact), email, nowIso);
  await saveSnap(db, found.contact, { emailFoundAt: new Date(nowIso), enrichmentRequestedAt: null });
  return { status: "found", vendorCalls };
}

export function hiddenWaitMs(): number {
  return config.email.hiddenWaitDays * 86_400_000;
}
