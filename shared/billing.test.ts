import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { createDb, type Database } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { contacts, creditLedger, emailSeats, linkedinSeats, organizations, users, webhookEvents } from "./db/schema.js";
import { applyLedger, debitCredits } from "./inbox/credits-db.js";
import { enrichContact } from "./inbox/enrich-run.js";
import { applyStripeEvent } from "./inbox/billing.js";
import { processWebhookEvent } from "./inbox/process.js";
import { receiveStripeWebhook } from "./inbox/receive.js";

const url = process.env.DATABASE_URL_SESSION ?? "postgres://reach:reach@127.0.0.1:5432/reach_test";

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

async function orgWith(balance: number, planBalance = balance) {
  const [org] = await db.insert(organizations).values({
    name: "Acme",
    creditsBalance: balance,
    planCreditsBalance: planBalance,
    stripeCustomerId: `cus_${randomUUID()}`,
  }).returning();
  return org!;
}

test("parallel debits stop at zero and a repeated ref debits once", async () => {
  const org = await orgWith(5);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => debitCredits(sql, org.id, `ref-${index}`, 1)));
  const applied = results.filter((result) => result.applied);
  expect(applied).toHaveLength(5);
  expect(results.filter((result) => result.error === "insufficient")).toHaveLength(5);
  const [saved] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(saved?.creditsBalance).toBe(0);
  expect(await db.select().from(creditLedger).where(eq(creditLedger.orgId, org.id))).toHaveLength(5);

  const other = await orgWith(5);
  const first = await debitCredits(sql, other.id, "same-ref", 1);
  const second = await debitCredits(sql, other.id, "same-ref", 1);
  expect(first.applied).toBe(true);
  expect(second).toMatchObject({ applied: false, error: "duplicate", balance: 4 });
  const [after] = await db.select().from(organizations).where(eq(organizations.id, other.id));
  expect(after?.creditsBalance).toBe(4);
  expect(await db.select().from(creditLedger).where(eq(creditLedger.orgId, other.id))).toHaveLength(1);
});

test("enrichment at zero credits does not call a vendor", async () => {
  const org = await orgWith(0, 0);
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, orgId: org.id, email: "owner@acme.test", role: "owner" });
  const [contact] = await db.insert(contacts).values({
    orgId: org.id,
    profileUrl: "https://www.linkedin.com/in/ada",
    name: "Ada Lovelace",
    status: "in_campaign",
  }).returning();
  let vendorCalls = 0;
  const outcome = await enrichContact(db, sql, contact!.id, {
    enrichment: {
      async findEmail() {
        vendorCalls += 1;
        return "ada@example.com";
      },
      async verify() {
        vendorCalls += 1;
        return true;
      },
    },
    resend: {
      async send() {
        return { id: "notice" };
      },
    },
  });
  expect(outcome).toEqual({ status: "hidden", vendorCalls: 0 });
  expect(vendorCalls).toBe(0);
  const [saved] = await db.select().from(contacts).where(eq(contacts.id, contact!.id));
  expect(saved?.emailStatus).toBe("hidden");
  expect(saved?.enrichmentNotifiedAt).toBeTruthy();
  const [balance] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(balance?.creditsBalance).toBe(0);
});

test("a found email debits one credit and a lost debit does not go negative", async () => {
  const org = await orgWith(1, 1);
  const [contact] = await db.insert(contacts).values({
    orgId: org.id,
    profileUrl: "https://www.linkedin.com/in/ada",
    name: "Ada Lovelace",
    company: "Analytical Engines",
    status: "in_campaign",
  }).returning();
  const outcome = await enrichContact(db, sql, contact!.id, {
    enrichment: {
      async findEmail() { return "ada@example.com"; },
      async verify() { return true; },
    },
  });
  expect(outcome.status).toBe("found");
  const [saved] = await db.select().from(contacts).where(eq(contacts.id, contact!.id));
  expect(saved?.email).toBe("ada@example.com");
  expect(saved?.emailStatus).toBe("found");
  const [balance] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(balance?.creditsBalance).toBe(0);
  const raced = await enrichContact(db, sql, contact!.id, {
    enrichment: {
      async findEmail() { throw new Error("vendor called"); },
      async verify() { throw new Error("vendor called"); },
    },
  });
  expect(raced).toEqual({ status: "found", vendorCalls: 0 });
  const blocked = await debitCredits(sql, org.id, "extra", 1);
  expect(blocked.error).toBe("insufficient");
  const [finalBalance] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(finalBalance?.creditsBalance).toBe(0);
});

test("stripe grants, top-ups, and cancellation do not invent success", async () => {
  const org = await orgWith(0, 0);
  const invoice = {
    id: "evt_invoice",
    type: "invoice.paid",
    data: { object: { id: "in_1", customer: org.stripeCustomerId, subscription: "sub_1" } },
  };
  await receiveStripeWebhook(db, { id: invoice.id, type: invoice.type, data: invoice.data.object }, invoice);
  const [stored] = await db.select().from(webhookEvents);
  await processWebhookEvent(db, stored!.dedupeKey, { sql });
  await applyStripeEvent(db, sql, { id: invoice.id, type: invoice.type, data: invoice.data.object }, {});
  const [granted] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(granted?.creditsBalance).toBe(100);
  expect(granted?.planCreditsBalance).toBe(100);
  expect(granted?.stripeSubscriptionId).toBe("sub_1");
  const grants = await db.select().from(creditLedger).where(eq(creditLedger.reason, "plan_grant"));
  expect(grants).toHaveLength(1);
  expect(grants[0]?.refId).toBe("in_1");

  await applyStripeEvent(db, sql, {
    id: "evt_top",
    type: "checkout.session.completed",
    data: { metadata: { kind: "top_up", org_id: org.id, credits: "500" } },
  }, {});
  const [topped] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(topped?.creditsBalance).toBe(600);
  expect(topped?.planCreditsBalance).toBe(100);

  await applyStripeEvent(db, sql, {
    id: "evt_fail",
    type: "invoice.payment_failed",
    data: { customer: org.stripeCustomerId },
  }, {});
  const [pastDue] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(pastDue?.status).toBe("past_due");

  const userId = randomUUID();
  await db.insert(users).values({ id: userId, orgId: org.id, email: "owner@acme.test", role: "owner" });
  await db.insert(linkedinSeats).values({ orgId: org.id, userId, unipileAccountId: "acc-li" });
  await expect(applyStripeEvent(db, sql, {
    id: "evt_cancel",
    type: "customer.subscription.deleted",
    data: { customer: org.stripeCustomerId },
  }, {})).rejects.toThrow(/Unipile is not configured/);
  expect(await db.select().from(linkedinSeats)).toHaveLength(1);
  const removed: string[] = [];
  await applyStripeEvent(db, sql, {
    id: "evt_cancel",
    type: "customer.subscription.deleted",
    data: { customer: org.stripeCustomerId },
  }, { deleteUnipileAccount: async (accountId) => { removed.push(accountId); } });
  expect(removed).toEqual(["acc-li"]);
  expect(await db.select().from(linkedinSeats)).toHaveLength(0);
  expect(await db.select().from(emailSeats)).toHaveLength(0);
  const [cancelled] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(cancelled?.status).toBe("cancelled");
  expect(cancelled?.dataDeletionAt).toBeTruthy();

  const empty = await orgWith(0, 0);
  await applyStripeEvent(db, sql, {
    id: "evt_empty",
    type: "customer.subscription.deleted",
    data: { customer: empty.stripeCustomerId },
  }, {});
  const [emptyOrg] = await db.select().from(organizations).where(eq(organizations.id, empty.id));
  expect(emptyOrg?.status).toBe("cancelled");
});

test("a top-up ledger row does not reduce plan credits", async () => {
  const org = await orgWith(10, 10);
  const result = await applyLedger(sql, org.id, { reason: "top_up", refId: "top-1", amount: 25 });
  expect(result).toMatchObject({ applied: true, balance: 35 });
  const [saved] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(saved?.planCreditsBalance).toBe(10);
});
