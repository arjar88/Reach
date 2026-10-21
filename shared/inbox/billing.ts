import { eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { config } from "../config.js";
import type { Database } from "../db/client.js";
import { agents, campaigns, emailSeats, linkedinSeats, organizations } from "../db/schema.js";
import { applyLedger, grantPlanPeriod } from "./credits-db.js";
import type { ProcessDeps } from "./process.js";

export interface StripeEventInput {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export async function applyStripeEvent(db: Database, sql: Sql, event: StripeEventInput, deps: Pick<ProcessDeps, "deleteUnipileAccount">): Promise<void> {
  if (event.type === "invoice.paid") {
    const customer = str(event.data.customer);
    if (!customer) return;
    const [org] = await db.select().from(organizations).where(eq(organizations.stripeCustomerId, customer)).limit(1);
    if (!org) return;
    const invoiceId = str(event.data.id) ?? event.id;
    const grant = config.credits.plans[org.plan] ?? config.credits.plans.pilot ?? 0;
    await grantPlanPeriod(sql, org.id, { grant, grantRef: invoiceId, expiryRef: `expiry:${invoiceId}` });
    if (!org.stripeSubscriptionId && str(event.data.subscription)) {
      await db.update(organizations).set({ stripeSubscriptionId: str(event.data.subscription), status: "active" }).where(eq(organizations.id, org.id));
    }
    return;
  }
  if (event.type === "invoice.payment_failed") {
    const customer = str(event.data.customer);
    if (!customer) return;
    await db.update(organizations).set({ status: "past_due" }).where(eq(organizations.stripeCustomerId, customer));
    return;
  }
  if (event.type === "checkout.session.completed") {
    const meta = (event.data.metadata ?? {}) as Record<string, string>;
    if (meta.kind !== "top_up") {
      const customer = str(event.data.customer);
      const orgId = meta.org_id;
      if (customer && orgId) {
        await db.update(organizations).set({ stripeCustomerId: customer, stripeSubscriptionId: str(event.data.subscription) }).where(eq(organizations.id, orgId));
      }
      return;
    }
    const orgId = meta.org_id;
    const credits = Number(meta.credits ?? config.credits.topUp);
    if (!orgId || !Number.isFinite(credits) || credits <= 0) return;
    await applyLedger(sql, orgId, { reason: "top_up", refId: event.id, amount: credits });
    return;
  }
  if (event.type === "customer.subscription.deleted") {
    const customer = str(event.data.customer);
    if (!customer) return;
    const [org] = await db.select().from(organizations).where(eq(organizations.stripeCustomerId, customer)).limit(1);
    if (!org) return;
    const deletion = new Date(Date.now() + config.scrape.cancelledOrgDays * 86_400_000);
    await db.update(organizations).set({ status: "cancelled", cancelledAt: new Date(), dataDeletionAt: deletion }).where(eq(organizations.id, org.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.orgId, org.id));
    await db.update(campaigns).set({ active: false }).where(eq(campaigns.orgId, org.id));
    const linkedin = await db.select().from(linkedinSeats).where(eq(linkedinSeats.orgId, org.id));
    const emails = await db.select().from(emailSeats).where(eq(emailSeats.orgId, org.id));
    const accountIds = [...linkedin.map((s) => s.unipileAccountId), ...emails.map((s) => s.unipileAccountId)];
    if (accountIds.length && !deps.deleteUnipileAccount) {
      throw new Error("Unipile is not configured; connected accounts were not deleted");
    }
    for (const accountId of accountIds) await deps.deleteUnipileAccount!(accountId);
    if (linkedin.length) await db.delete(linkedinSeats).where(eq(linkedinSeats.orgId, org.id));
    if (emails.length) await db.delete(emailSeats).where(eq(emailSeats.orgId, org.id));
  }
}
