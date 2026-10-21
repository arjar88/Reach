import { and, eq, gte, isNotNull, lt, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Sql } from "postgres";
import { config } from "../config.js";
import type { Database } from "../db/client.js";
import {
  actions, campaigns, contacts, emailSeats, linkedinSeats, orgDailySummaries, organizations,
  postEngagers, providerCalls, providerRuntime, scrapedPosts, seenPeople, threadMessages, users, webhookEvents,
} from "../db/schema.js";
import { forOrg } from "../db/scope.js";
import type { ResendClient } from "../providers/resend.js";
import type { UnipileClient } from "../providers/unipile.js";
import { onInviteTimeout } from "../sequence.js";
import { applyEffects, loadSteps, saveSnap, toSnap } from "./persist.js";

export interface DailyDeps {
  unipile?: UnipileClient;
  resend?: ResendClient;
  now?: Date;
}

export interface DailyResult {
  invitesTimedOut: number;
  withdrawals: number;
  orgsDeleted: number;
  summaries: number;
}

const DAY = 86_400_000;

function local(now: Date, zone: string): DateTime {
  const zoned = DateTime.fromJSDate(now, { zone });
  return zoned.isValid ? zoned : DateTime.fromJSDate(now, { zone: "UTC" });
}

async function invitationStillOut(
  unipile: UnipileClient | undefined,
  cache: Map<string, Set<string> | null>,
  accountId: string | null,
  providerId: string | null,
): Promise<boolean | null> {
  if (!unipile || !accountId || !providerId) return null;
  if (!cache.has(accountId)) {
    try {
      const rows = await unipile.listInvitations(accountId);
      cache.set(accountId, new Set(rows.map((row) => row.providerId)));
    } catch {
      cache.set(accountId, null);
    }
  }
  const pending = cache.get(accountId);
  if (!pending) return null;
  return pending.has(providerId);
}

async function timeOutInvites(db: Database, deps: DailyDeps, now: Date): Promise<{ invitesTimedOut: number; withdrawals: number }> {
  const cutoff = new Date(now.getTime() - config.linkedin.inviteTimeoutDays * DAY);
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const cache = new Map<string, Set<string> | null>();
  let invitesTimedOut = 0;
  let withdrawals = 0;
  for (const org of orgs) {
    const due = await db.select().from(contacts).where(and(
      forOrg(org.id, contacts.orgId),
      eq(contacts.status, "awaiting_acceptance"),
      isNotNull(contacts.invitedAt),
      lte(contacts.invitedAt, cutoff),
    ));
    for (const contact of due) {
      const [invite] = await db.select().from(actions).where(and(
        forOrg(org.id, actions.orgId),
        eq(actions.contactId, contact.id),
        eq(actions.type, "invite"),
      )).limit(1);
      let seatId = invite?.linkedinSeatId ?? null;
      if (!seatId && contact.campaignId) {
        const [campaign] = await db.select().from(campaigns).where(and(
          forOrg(org.id, campaigns.orgId),
          eq(campaigns.id, contact.campaignId),
        )).limit(1);
        seatId = campaign?.linkedinSeatId ?? null;
      }
      let accountId: string | null = null;
      if (seatId) {
        const [seat] = await db.select().from(linkedinSeats).where(and(
          forOrg(org.id, linkedinSeats.orgId),
          eq(linkedinSeats.id, seatId),
        )).limit(1);
        accountId = seat?.unipileAccountId ?? null;
        if (!seat) seatId = null;
      }
      const still = await invitationStillOut(deps.unipile, cache, accountId, contact.providerId);
      const pending = still === null ? !contact.acceptedAt : still;
      const connected = still === true ? false : Boolean(contact.acceptedAt);
      const steps = await loadSteps(db, contact.campaignId);
      const next = onInviteTimeout({ contact: toSnap(contact), steps, nowIso: now.toISOString(), pending, connected });
      await saveSnap(db, next.contact);
      await applyEffects(db, contact.id, next.effects);
      invitesTimedOut += 1;
      if (next.effects.some((effect) => effect.type === "schedule_withdraw") && seatId) {
        const [existing] = await db.select({ id: actions.id }).from(actions).where(and(
          forOrg(org.id, actions.orgId),
          eq(actions.contactId, contact.id),
          eq(actions.type, "withdraw"),
        )).limit(1);
        if (!existing) {
          await db.insert(actions).values({
            orgId: org.id,
            contactId: contact.id,
            campaignStepId: null,
            source: "sequence",
            type: "withdraw",
            linkedinSeatId: seatId,
            status: "ready",
            scheduledFor: now,
          });
          withdrawals += 1;
        }
      }
    }
  }
  return { invitesTimedOut, withdrawals };
}

async function refreshAccounts(db: Database, unipile: UnipileClient, now: Date): Promise<void> {
  const accounts = await unipile.listAccounts();
  for (const account of accounts) {
    const ok = account.status.toUpperCase() === "OK";
    const patch = {
      unipileStatus: account.status,
      statusChangedAt: now,
      pausedReason: ok ? null : account.status,
    };
    await db.update(linkedinSeats).set(patch).where(eq(linkedinSeats.unipileAccountId, account.id));
    await db.update(emailSeats).set(patch).where(eq(emailSeats.unipileAccountId, account.id));
    if (!account.type.toUpperCase().includes("LINKEDIN")) continue;
    try {
      const profile = await unipile.getOwnProfile(account.id);
      await db.update(linkedinSeats).set({ connectionsCount: profile.connections }).where(eq(linkedinSeats.unipileAccountId, account.id));
    } catch {
      // A failed profile read leaves the stored connection count alone.
    }
  }
}

async function resetMonthlyScores(db: Database, now: Date): Promise<void> {
  const orgs = await db.select().from(organizations);
  for (const org of orgs) {
    const here = local(now, org.timezone);
    if (here.day !== org.billingAnchorDay) continue;
    const month = here.toFormat("yyyy-MM");
    const key = `scored_reset:${org.id}`;
    const [row] = await db.select().from(providerRuntime).where(eq(providerRuntime.key, key)).limit(1);
    const stored = row?.value as { month?: string } | null;
    if (stored?.month === month) continue;
    await db.update(organizations).set({ scoredThisMonth: 0 }).where(eq(organizations.id, org.id));
    await db.insert(providerRuntime).values({ key, value: { month } }).onConflictDoUpdate({
      target: providerRuntime.key,
      set: { value: { month } },
    });
  }
}

async function retain(db: Database, now: Date): Promise<number> {
  await db.delete(seenPeople).where(lt(seenPeople.seenAt, new Date(now.getTime() - config.scrape.seenDays * DAY)));
  await db.delete(postEngagers).where(lt(postEngagers.scrapedAt, new Date(now.getTime() - config.scrape.engagersDays * DAY)));
  await db.delete(scrapedPosts).where(lt(scrapedPosts.lastScrapedAt, new Date(now.getTime() - config.scrape.postsDays * DAY)));
  await db.delete(providerCalls).where(lt(providerCalls.createdAt, new Date(now.getTime() - config.scrape.providerCallsDays * DAY)));
  await db.delete(webhookEvents).where(and(
    isNotNull(webhookEvents.processedAt),
    lt(webhookEvents.processedAt, new Date(now.getTime() - config.scrape.webhookDays * DAY)),
  ));
  const removed = await db.delete(organizations).where(and(
    eq(organizations.status, "cancelled"),
    isNotNull(organizations.dataDeletionAt),
    lte(organizations.dataDeletionAt, now),
  )).returning({ id: organizations.id });
  return removed.length;
}

async function sendDailySummaries(db: Database, resend: ResendClient | undefined, now: Date): Promise<number> {
  if (!resend) return 0;
  const orgs = await db.select().from(organizations).where(eq(organizations.status, "active"));
  let sent = 0;
  for (const org of orgs) {
    const here = local(now, org.timezone);
    if (here.hour !== 8) continue;
    const day = here.toISODate();
    if (!day) continue;
    const start = here.startOf("day").minus({ days: 1 }).toJSDate();
    const end = here.startOf("day").toJSDate();
    const outbound = await db.select({ id: actions.id }).from(actions).where(and(
      forOrg(org.id, actions.orgId),
      eq(actions.status, "sent"),
      gte(actions.sentAt, start),
      lt(actions.sentAt, end),
    ));
    const inboundRows = await db.select({ id: threadMessages.id }).from(threadMessages).where(and(
      forOrg(org.id, threadMessages.orgId),
      eq(threadMessages.direction, "in"),
      gte(threadMessages.sentAt, start),
      lt(threadMessages.sentAt, end),
    ));
    const sentCount = outbound.length;
    const replies = inboundRows.length;
    const [owner] = await db.select().from(users).where(and(forOrg(org.id, users.orgId), eq(users.role, "owner"))).limit(1);
    if (!owner) continue;
    const inserted = await db.insert(orgDailySummaries).values({ orgId: org.id, localDate: day }).onConflictDoNothing().returning({ orgId: orgDailySummaries.orgId });
    if (!inserted.length) continue;
    try {
      await resend.send({
        to: owner.email,
        subject: `Reach summary ${day}`,
        text: `${sentCount} actions sent yesterday and ${replies} replies came in.`,
      });
      sent += 1;
    } catch (error) {
      await db.delete(orgDailySummaries).where(and(eq(orgDailySummaries.orgId, org.id), eq(orgDailySummaries.localDate, day)));
      throw error;
    }
  }
  return sent;
}

/** 03:00 UTC retention, invite timeouts, account refresh, and the monthly score reset. */
export async function runDailyTick(db: Database, _sql: Sql, deps: DailyDeps = {}): Promise<DailyResult> {
  const now = deps.now ?? new Date();
  const invites = await timeOutInvites(db, deps, now);
  if (deps.unipile) await refreshAccounts(db, deps.unipile, now);
  await resetMonthlyScores(db, now);
  const orgsDeleted = await retain(db, now);
  const summaries = await sendDailySummaries(db, deps.resend, now);
  return { ...invites, orgsDeleted, summaries };
}
