import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Database } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import {
  actions, campaignSteps, campaigns, contacts, emailSeats, linkedinSeats, lists, organizations, profilesCache,
  seenPeople, suppressions, threads, threadMessages, users, webhookEvents, jobRequests,
} from "./db/schema.js";
import { forOrg } from "./db/scope.js";
import { applyProfileOptOut, applyUnsubscribe } from "./inbox/compliance.js";
import { dashboardFunnel } from "./inbox/dashboard.js";
import { runDailyTick } from "./inbox/daily.js";
import { processJobRequest, processWebhookEvent } from "./inbox/process.js";
import { queueManualReply } from "./inbox/reply.js";
import { receiveUnipileWebhook } from "./inbox/receive.js";
import type { Sql } from "postgres";

const url = process.env.DATABASE_URL_SESSION ?? "postgres://reach:reach@127.0.0.1:5432/reach_test";
const secret = process.env.UNIPILE_WEBHOOK_SECRET ?? "test-unipile-secret";

let db: Database;
let sql: Sql;

beforeAll(async () => {
  await migrate(url);
  const conn = createDb(url, "worker");
  db = conn.db;
  sql = conn.sql;
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`
    TRUNCATE organizations, scraped_posts, post_engagers, profiles_cache, companies_cache,
      provider_runtime, rate_limit_buckets, worker_heartbeats
    RESTART IDENTITY CASCADE
  `;
});

async function seedLinkedIn() {
  const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, orgId: org!.id, email: "owner@acme.test", role: "owner" });
  const [list] = await db.insert(lists).values({ orgId: org!.id, name: "Leads" }).returning();
  const [seat] = await db.insert(linkedinSeats).values({
    orgId: org!.id,
    userId,
    unipileAccountId: "acc-li",
    linkedinProviderId: "owner-prov",
  }).returning();
  const [campaign] = await db.insert(campaigns).values({
    orgId: org!.id,
    listId: list!.id,
    name: "Outbound",
    linkedinSeatId: seat!.id,
    active: true,
  }).returning();
  await db.insert(campaignSteps).values([
    { orgId: org!.id, campaignId: campaign!.id, position: 1, type: "visit", delayDays: 0 },
    { orgId: org!.id, campaignId: campaign!.id, position: 2, type: "invite", delayDays: 1 },
    { orgId: org!.id, campaignId: campaign!.id, position: 3, type: "message", delayDays: 1 },
  ]);
  const [contact] = await db.insert(contacts).values({
    orgId: org!.id,
    profileUrl: "https://www.linkedin.com/in/ada",
    providerId: "ada-prov",
    name: "Ada Lovelace",
    status: "in_campaign",
    campaignId: campaign!.id,
    currentStep: 2,
  }).returning();
  const [inviteStep] = await db.select().from(campaignSteps).where(and(
    eq(campaignSteps.campaignId, campaign!.id),
    eq(campaignSteps.position, 2),
  ));
  const [invite] = await db.insert(actions).values({
    orgId: org!.id,
    contactId: contact!.id,
    campaignStepId: inviteStep!.id,
    source: "sequence",
    type: "invite",
    linkedinSeatId: seat!.id,
    status: "sending",
  }).returning();
  return { org: org!, userId, seat: seat!, campaign: campaign!, contact: contact!, invite: invite! };
}

function messagePayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "message_received",
    account_id: "acc-li",
    message_id: "msg-1",
    chat_id: "chat-1",
    message: "Thanks for the note and I wanted to talk with you.",
    timestamp: "2026-10-21T12:00:00.000Z",
    sender: { attendee_provider_id: "ada-prov" },
    account_info: { user_id: "owner-prov" },
    attendees: [
      { attendee_provider_id: "owner-prov" },
      { attendee_provider_id: "ada-prov" },
    ],
    ...overrides,
  };
}

test("a bad secret is 401 and stores nothing", async () => {
  await seedLinkedIn();
  const result = await receiveUnipileWebhook(db, {
    secretHeader: "nope",
    expectedSecret: secret,
    payload: messagePayload(),
  });
  expect(result).toEqual({ status: 401, stored: false });
  expect(await db.select().from(webhookEvents)).toHaveLength(0);
});

test("an unmatched message or email is acknowledged and not stored", async () => {
  const { org, contact, seat } = await seedLinkedIn();
  const [emailSeat] = await db.insert(emailSeats).values({
    orgId: org.id,
    userId: seat.userId,
    address: "owner@acme.test",
    unipileAccountId: "acc-em",
  }).returning();
  await db.insert(actions).values({
    orgId: org.id,
    contactId: contact.id,
    source: "sequence",
    type: "email",
    emailSeatId: emailSeat!.id,
    status: "sent",
    emailMessageId: "sent-msg-1",
  });
  const message = await receiveUnipileWebhook(db, {
    secretHeader: secret,
    expectedSecret: secret,
    payload: messagePayload({ message_id: "stranger", attendees: [{ attendee_provider_id: "stranger" }, { attendee_provider_id: "owner-prov" }], sender: { attendee_provider_id: "stranger" } }),
  });
  const mail = await receiveUnipileWebhook(db, {
    secretHeader: secret,
    expectedSecret: secret,
    payload: {
      event: "mail_received",
      account_id: "acc-em",
      message_id: "mail-unknown",
      date: "2026-10-21T12:00:00.000Z",
      subject: "Hello",
      body: "No match",
      from_attendee: { identifier: "other@example.com" },
      in_reply_to: { message_id: "not-ours" },
    },
  });
  expect(message).toEqual({ status: 200, stored: false });
  expect(mail).toEqual({ status: 200, stored: false });
  expect(await db.select().from(webhookEvents)).toHaveLength(0);
});

test("a late reply from a finished contact is stored, labeled as inbound, and stops the sequence", async () => {
  const { org, contact } = await seedLinkedIn();
  await db.update(contacts).set({ status: "finished", finishedReason: "completed" }).where(eq(contacts.id, contact.id));
  const payload = messagePayload({ message_id: "msg-late" });
  const first = await receiveUnipileWebhook(db, { secretHeader: secret, expectedSecret: secret, payload });
  const second = await receiveUnipileWebhook(db, { secretHeader: secret, expectedSecret: secret, payload });
  expect(first).toEqual({ status: 200, stored: true });
  expect(second).toEqual({ status: 200, stored: false });
  expect(await db.select().from(webhookEvents)).toHaveLength(1);
  const [row] = await db.select().from(webhookEvents);
  await processWebhookEvent(db, row!.dedupeKey, { sql });
  const [saved] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
  expect(saved?.status).toBe("replied");
  const [thread] = await db.select().from(threads).where(forOrg(org.id, threads.orgId));
  const messages = await db.select().from(threadMessages).where(eq(threadMessages.threadId, thread!.id));
  expect(messages).toHaveLength(1);
  expect(messages[0]?.direction).toBe("in");
  const [cleared] = await db.select().from(webhookEvents);
  expect(cleared?.payload).toBeNull();
  expect(cleared?.processedAt).toBeTruthy();
});

test("an owner message is outbound and is not a reply", async () => {
  const { contact } = await seedLinkedIn();
  const payload = messagePayload({
    message_id: "msg-own",
    sender: { attendee_provider_id: "owner-prov" },
    message: "Following up with you on this.",
  });
  const result = await receiveUnipileWebhook(db, { secretHeader: secret, expectedSecret: secret, payload });
  expect(result.stored).toBe(true);
  const [row] = await db.select().from(webhookEvents);
  await processWebhookEvent(db, row!.dedupeKey, { sql });
  const [saved] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
  expect(saved?.status).toBe("in_campaign");
  const [message] = await db.select().from(threadMessages);
  expect(message?.direction).toBe("out");
});

test("auto-replies are ignored and bounces mark the email without a reply", async () => {
  const { org, contact, seat } = await seedLinkedIn();
  await db.update(contacts).set({ email: "ada@example.com" }).where(eq(contacts.id, contact.id));
  const [emailSeat] = await db.insert(emailSeats).values({
    orgId: org.id,
    userId: seat.userId,
    address: "owner@acme.test",
    unipileAccountId: "acc-em",
  }).returning();
  await db.insert(actions).values({
    orgId: org.id,
    contactId: contact.id,
    source: "sequence",
    type: "email",
    emailSeatId: emailSeat!.id,
    status: "sent",
    emailMessageId: "sent-msg-1",
  });
  const auto = await receiveUnipileWebhook(db, {
    secretHeader: secret,
    expectedSecret: secret,
    payload: {
      event: "mail_received",
      account_id: "acc-em",
      message_id: "mail-auto",
      date: "2026-10-21T12:00:00.000Z",
      subject: "Automatic reply",
      body: "I am away",
      from_attendee: { identifier: "ada@example.com" },
      in_reply_to: { message_id: "sent-msg-1" },
      headers: { "Auto-Submitted": "auto-replied" },
    },
  });
  expect(auto.stored).toBe(true);
  const [autoRow] = await db.select().from(webhookEvents);
  await processWebhookEvent(db, autoRow!.dedupeKey, { sql });
  const [afterAuto] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
  expect(afterAuto?.status).toBe("in_campaign");
  expect(await db.select().from(threadMessages)).toHaveLength(0);

  const bounce = await receiveUnipileWebhook(db, {
    secretHeader: secret,
    expectedSecret: secret,
    payload: {
      event: "mail_received",
      account_id: "acc-em",
      message_id: "mail-bounce",
      date: "2026-10-21T13:00:00.000Z",
      subject: "Delivery Status Notification",
      body: "undeliverable",
      from_attendee: { identifier: "mailer-daemon@googlemail.com" },
      in_reply_to: { message_id: "sent-msg-1" },
    },
  });
  expect(bounce.stored).toBe(true);
  const rows = await db.select().from(webhookEvents);
  const bounceRow = rows.find((row) => row.dedupeKey.includes("mail-bounce"));
  await processWebhookEvent(db, bounceRow!.dedupeKey, { sql });
  const [afterBounce] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
  expect(afterBounce?.status).toBe("in_campaign");
  expect(afterBounce?.emailStatus).toBe("bounced");
  expect(await db.select().from(threadMessages)).toHaveLength(0);
});

test("new_relation records acceptance while the invite is still sending", async () => {
  const { org, contact, invite } = await seedLinkedIn();
  const result = await receiveUnipileWebhook(db, {
    secretHeader: secret,
    expectedSecret: secret,
    payload: {
      event: "new_relation",
      account_id: "acc-li",
      user_provider_id: "ada-prov",
      timestamp: "2026-10-21T15:00:00.000Z",
    },
  });
  expect(result.stored).toBe(true);
  const [row] = await db.select().from(webhookEvents);
  await processWebhookEvent(db, row!.dedupeKey, { sql });
  const [saved] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
  expect(saved?.acceptedAt).toBeTruthy();
  expect(saved?.status).toBe("in_campaign");
  expect(saved?.currentStep).toBe(3);
  const [sending] = await db.select().from(actions).where(eq(actions.id, invite.id));
  expect(sending?.status).toBe("sending");
  const funnel = await dashboardFunnel(db, org.id);
  expect(funnel.accepted).toBe(1);
  expect(funnel.contacts.in_campaign).toBe(1);
});

test("inbox reply is created as sending and a failed enqueue does not create a second action", async () => {
  const { org, contact, seat, invite } = await seedLinkedIn();
  const queued = await queueManualReply(db, org.id, {
    contactId: contact.id,
    channel: "linkedin",
    body: "Thanks for the note and I wanted to talk with you.",
    linkedinSeatId: seat.id,
  });
  expect("jobId" in queued).toBe(true);
  if (!("jobId" in queued)) return;
  await expect(processJobRequest(db, queued.jobId, {
    sql,
    enqueueSend: async () => { throw new Error("queue down"); },
  })).rejects.toThrow("queue down");
  const [failed] = await db.select().from(jobRequests).where(eq(jobRequests.id, queued.jobId));
  expect(failed?.status).toBe("failed");
  const payload = failed?.payload as { actionId?: string };
  expect(payload.actionId).toBeTruthy();
  const sent: string[] = [];
  await processJobRequest(db, queued.jobId, {
    sql,
    enqueueSend: async (actionId) => { sent.push(actionId); },
  });
  const manual = await db.select().from(actions).where(eq(actions.source, "manual"));
  expect(manual).toHaveLength(1);
  expect(manual[0]?.status).toBe("sending");
  expect(manual[0]?.id).toBe(payload.actionId);
  expect(sent).toEqual([payload.actionId]);
  const [stillSending] = await db.select().from(actions).where(eq(actions.id, invite.id));
  expect(stillSending?.status).toBe("sending");
});

test("profile opt-out deletes the person in every org and unsubscribe keeps the contact", async () => {
  const first = await seedLinkedIn();
  const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
  const otherUser = randomUUID();
  await db.insert(users).values({ id: otherUser, orgId: other!.id, email: "owner@other.test", role: "owner" });
  await db.insert(contacts).values({
    orgId: other!.id,
    profileUrl: "https://www.linkedin.com/in/ada",
    providerId: "ada-prov",
    name: "Ada Lovelace",
    email: "ada@example.com",
    status: "approved",
  });
  await db.update(contacts).set({ email: "ada@example.com" }).where(eq(contacts.id, first.contact.id));
  await db.insert(seenPeople).values({
    orgId: first.org.id,
    profileUrl: "https://www.linkedin.com/in/ada",
    signalKey: "keyword:reach",
  });
  await db.insert(profilesCache).values({ profileUrl: "https://www.linkedin.com/in/ada", name: "Ada" });
  await applyUnsubscribe(db, { orgId: first.org.id, email: "Ada@Example.com" });
  const [kept] = await db.select().from(contacts).where(eq(contacts.id, first.contact.id));
  expect(kept?.status).toBe("suppressed");
  const [otherContact] = await db.select().from(contacts).where(forOrg(other!.id, contacts.orgId));
  expect(otherContact?.status).toBe("approved");
  const orgSuppressions = await db.select().from(suppressions).where(eq(suppressions.orgId, first.org.id));
  expect(orgSuppressions.length).toBeGreaterThan(0);

  const removed = await applyProfileOptOut(db, "linkedin.com/in/Ada");
  expect(removed.deleted).toBe(2);
  expect(await db.select().from(contacts)).toHaveLength(0);
  expect(await db.select().from(seenPeople)).toHaveLength(0);
  expect(await db.select().from(profilesCache)).toHaveLength(0);
  const globalRows = await db.select().from(suppressions).where(eq(suppressions.profileUrl, "https://www.linkedin.com/in/ada"));
  expect(globalRows.some((row) => row.orgId === null)).toBe(true);
  const again = await applyProfileOptOut(db, "https://www.linkedin.com/in/ada");
  expect(again.deleted).toBe(0);
});

test("the daily tick times out a 21-day invite, resets the month, and deletes due orgs", async () => {
  const { org, contact, invite } = await seedLinkedIn();
  await db.update(contacts).set({
    status: "awaiting_acceptance",
    invitedAt: new Date("2026-09-01T00:00:00.000Z"),
  }).where(eq(contacts.id, contact.id));
  await db.update(actions).set({ status: "sent" }).where(eq(actions.id, invite.id));
  await db.update(organizations).set({ scoredThisMonth: 12, billingAnchorDay: 21, timezone: "UTC" }).where(eq(organizations.id, org.id));
  await db.insert(seenPeople).values({
    orgId: org.id,
    profileUrl: "https://www.linkedin.com/in/old",
    signalKey: "keyword:old",
    seenAt: new Date("2026-08-01T00:00:00.000Z"),
  });
  const [doomed] = await db.insert(organizations).values({
    name: "Gone",
    status: "cancelled",
    dataDeletionAt: new Date("2026-10-01T00:00:00.000Z"),
  }).returning();
  const summaryUser = randomUUID();
  const [summaryOrg] = await db.insert(organizations).values({ name: "East", timezone: "Etc/GMT-5" }).returning();
  await db.insert(users).values({ id: summaryUser, orgId: summaryOrg!.id, email: "east@example.com", role: "owner" });
  const sentTo: string[] = [];
  const now = new Date("2026-10-21T03:00:00.000Z");
  const unipile = {
    async listAccounts() {
      return [{ id: "acc-li", type: "LINKEDIN", status: "CREDENTIALS" }];
    },
    async getOwnProfile() {
      return { providerId: "owner-prov", premium: false, connections: 42, firstName: null, headline: null };
    },
  };
  const first = await runDailyTick(db, sql, {
    now,
    unipile: unipile as never,
    resend: { async send(input) { sentTo.push(input.to); return { id: "mail" }; } },
  });
  const [saved] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
  expect(saved?.status).toBe("finished");
  expect(saved?.finishedReason).toBe("invite_timeout");
  const [withdraw] = await db.select().from(actions).where(eq(actions.type, "withdraw"));
  expect(withdraw?.status).toBe("ready");
  const [inviteRow] = await db.select().from(actions).where(eq(actions.id, invite.id));
  expect(inviteRow?.status).toBe("sent");
  expect(first.withdrawals).toBe(1);
  expect(await db.select().from(seenPeople)).toHaveLength(0);
  const [reset] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(reset?.scoredThisMonth).toBe(0);
  expect(await db.select().from(organizations).where(eq(organizations.id, doomed!.id))).toHaveLength(0);
  const [seat] = await db.select().from(linkedinSeats).where(eq(linkedinSeats.unipileAccountId, "acc-li"));
  expect(seat?.pausedReason).toBe("CREDENTIALS");
  expect(seat?.connectionsCount).toBe(42);
  expect(sentTo).toEqual(["east@example.com"]);
  const second = await runDailyTick(db, sql, {
    now,
    resend: { async send() { throw new Error("sent twice"); } },
  });
  expect(second.summaries).toBe(0);
  expect(second.invitesTimedOut).toBe(0);
});
