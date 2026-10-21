import { timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { actions, contacts, emailSeats, linkedinSeats, webhookEvents } from "../db/schema.js";
import { forOrg } from "../db/scope.js";
import { accountStatusKey, mailEventKey, messageEventKey, relationEventKey, stripeKey } from "../webhook-keys.js";
import { parseUnipileWebhook, type NormalizedWebhook } from "../providers/unipile.js";

export interface SeatRef {
  kind: "linkedin" | "email";
  id: string;
  orgId: string;
  ownerProviderId: string | null;
}

function secretsMatch(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function findSeat(db: Database, accountId: string): Promise<SeatRef | null> {
  if (!accountId) return null;
  const [linkedin] = await db.select().from(linkedinSeats).where(eq(linkedinSeats.unipileAccountId, accountId)).limit(1);
  if (linkedin) {
    return { kind: "linkedin", id: linkedin.id, orgId: linkedin.orgId, ownerProviderId: linkedin.linkedinProviderId };
  }
  const [email] = await db.select().from(emailSeats).where(eq(emailSeats.unipileAccountId, accountId)).limit(1);
  if (email) return { kind: "email", id: email.id, orgId: email.orgId, ownerProviderId: null };
  return null;
}

async function contactedOnLinkedIn(db: Database, seat: SeatRef, providerId: string) {
  const [contact] = await db.select().from(contacts).where(and(
    forOrg(seat.orgId, contacts.orgId),
    eq(contacts.providerId, providerId),
  )).limit(1);
  if (!contact) return null;
  const [action] = await db.select({ id: actions.id }).from(actions).where(and(
    eq(actions.contactId, contact.id),
    eq(actions.linkedinSeatId, seat.id),
    inArray(actions.type, ["visit", "invite", "message", "withdraw"]),
  )).limit(1);
  return action ? contact : null;
}

async function contactedOnEmail(db: Database, seat: SeatRef, event: Extract<NormalizedWebhook, { kind: "mail_received" | "mail_sent" }>) {
  if (event.kind === "mail_received" && event.inReplyTo) {
    const [action] = await db.select().from(actions).where(and(
      forOrg(seat.orgId, actions.orgId),
      eq(actions.emailSeatId, seat.id),
      eq(actions.emailMessageId, event.inReplyTo),
    )).limit(1);
    if (action) {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, action.contactId)).limit(1);
      if (contact) return contact;
    }
  }
  const from = event.kind === "mail_received" ? event.from : null;
  if (!from) return null;
  const rows = await db.select().from(contacts).where(and(
    forOrg(seat.orgId, contacts.orgId),
    sql`lower(${contacts.email}) = ${from.toLowerCase()}`,
  ));
  for (const contact of rows) {
    const [action] = await db.select({ id: actions.id }).from(actions).where(and(
      eq(actions.contactId, contact.id),
      eq(actions.emailSeatId, seat.id),
      eq(actions.type, "email"),
    )).limit(1);
    if (action) return contact;
  }
  return null;
}

function eventKey(event: NormalizedWebhook): string | null {
  if (event.kind === "message" && event.messageId) return messageEventKey(event.messageId);
  if (event.kind === "new_relation" && event.providerId) return relationEventKey(event.accountId, event.providerId);
  if (event.kind === "account_status" && event.accountId) return accountStatusKey(event.accountId, event.status, event.at);
  if (event.kind === "mail_sent") return mailEventKey("sent", event.trackingId ?? event.messageId ?? event.accountId);
  if (event.kind === "mail_received") return mailEventKey("received", event.messageId ?? `${event.from ?? "unknown"}:${event.at}`);
  return null;
}

export async function insertWebhook(db: Database, opts: {
  dedupeKey: string;
  source: string;
  orgId: string | null;
  payload: unknown;
}): Promise<boolean> {
  const inserted = await db.insert(webhookEvents).values({
    dedupeKey: opts.dedupeKey,
    source: opts.source,
    orgId: opts.orgId,
    payload: opts.payload,
  }).onConflictDoNothing().returning({ dedupeKey: webhookEvents.dedupeKey });
  return inserted.length > 0;
}

/**
 * Match, then store. Unknown accounts and private chats are acknowledged and not stored.
 * A bad secret is 401. Duplicates are 200 and do not insert a second row.
 */
export async function receiveUnipileWebhook(db: Database, opts: {
  secretHeader: string | null;
  expectedSecret: string;
  payload: unknown;
}): Promise<{ status: number; stored: boolean }> {
  if (!opts.secretHeader || !secretsMatch(opts.secretHeader, opts.expectedSecret)) {
    return { status: 401, stored: false };
  }
  const event = parseUnipileWebhook(opts.payload);
  if (event.kind === "ignore") return { status: 200, stored: false };
  const seat = await findSeat(db, event.accountId);
  if (!seat) return { status: 200, stored: false };
  if (event.kind === "message") {
    const attendee = event.attendeeProviderId;
    if (!attendee || !(await contactedOnLinkedIn(db, seat, attendee))) return { status: 200, stored: false };
  }
  if (event.kind === "new_relation") {
    if (!event.providerId || !(await contactedOnLinkedIn(db, seat, event.providerId))) return { status: 200, stored: false };
  }
  if (event.kind === "mail_received" || event.kind === "mail_sent") {
    if (seat.kind !== "email") return { status: 200, stored: false };
    if (event.kind === "mail_received" && !(await contactedOnEmail(db, seat, event))) return { status: 200, stored: false };
  }
  const key = eventKey(event);
  if (!key) return { status: 200, stored: false };
  const stored = await insertWebhook(db, { dedupeKey: key, source: "unipile", orgId: seat.orgId, payload: opts.payload });
  return { status: 200, stored };
}

export async function receiveStripeWebhook(db: Database, event: { id: string; type: string; data: Record<string, unknown> }, raw: unknown): Promise<{ status: number; stored: boolean }> {
  if (!event.id) return { status: 400, stored: false };
  const stored = await insertWebhook(db, { dedupeKey: stripeKey(event.id), source: "stripe", orgId: null, payload: raw });
  return { status: 200, stored };
}
