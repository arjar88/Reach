"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { config } from "../../../../../shared/config.js";
import { emailSeats, organizations } from "../../../../../shared/db/schema.js";
import { forOrg } from "../../../../../shared/db/scope.js";
import { checkDomain } from "../../../../../shared/inbox/dns.js";
import { createStripe } from "../../../../../shared/providers/stripe.js";
import { requireOrg } from "../../../lib/session";

function allowedPrices(): string[] {
  return [process.env.STRIPE_PRICE_PILOT, process.env.STRIPE_PRICE_BASIC, process.env.STRIPE_PRICE_TOPUP].filter((price): price is string => Boolean(price));
}

export async function startCheckout(form: FormData): Promise<void> {
  const priceId = String(form.get("price") ?? "");
  const mode = form.get("mode") === "payment" ? "payment" : "subscription";
  if (!process.env.STRIPE_SECRET_KEY || !allowedPrices().includes(priceId)) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY and the STRIPE_PRICE_* ids.");
  }
  const { db, orgId } = await requireOrg();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new Error("Organization not found");
  const session = await createStripe().createCheckout({
    customerId: org.stripeCustomerId,
    priceId,
    orgId,
    mode,
    credits: mode === "payment" ? config.credits.topUp : undefined,
  });
  redirect(session.url);
}

export async function openPortal(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY.");
  const { db, orgId } = await requireOrg();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org?.stripeCustomerId) throw new Error("This organization has no Stripe customer yet.");
  const portal = await createStripe().createPortal(org.stripeCustomerId);
  redirect(portal.url);
}

export async function refreshDomain(form: FormData): Promise<void> {
  const { db, orgId } = await requireOrg();
  const seatId = String(form.get("seatId") ?? "");
  const [seat] = await db.select().from(emailSeats).where(and(forOrg(orgId, emailSeats.orgId), eq(emailSeats.id, seatId))).limit(1);
  if (!seat) throw new Error("Email seat not found");
  const domain = seat.address.split("@")[1];
  if (!domain) throw new Error("Email seat has no domain");
  const check = await checkDomain(domain);
  await db.update(emailSeats).set({ domainCheck: check }).where(eq(emailSeats.id, seat.id));
}
