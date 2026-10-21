import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyEntry, canCallVendor, debitEnrich, rolloverPlan, type CreditState } from "./credits.js";
import { debitCredits } from "./db/credits.js";
import { insertOrg, resetTables, testDatabase } from "./db/test-support.js";

const empty: CreditState = { balance: 0, planBalance: 0, entries: [] };

describe("credits ledger", () => {
  it("does not go below zero and ignores a duplicate ref", () => {
    const first = debitEnrich({ ...empty, balance: 1, planBalance: 1 }, "contact-1");
    expect(first.applied).toBe(true);
    expect(first.state.balance).toBe(0);
    const second = debitEnrich(first.state, "contact-2");
    expect(second.applied).toBe(false);
    expect(second.state.balance).toBe(0);
    const again = debitEnrich({ ...empty, balance: 5, planBalance: 5 }, "contact-1");
    const duplicate = applyEntry(again.state, { reason: "enrich", refId: "contact-1", amount: -1 });
    expect(duplicate.error).toBe("duplicate");
    expect(duplicate.state.balance).toBe(again.state.balance);
  });

  it("expires unused plan credits before the next grant", () => {
    const granted = applyEntry(empty, { reason: "plan_grant", refId: "in_1", amount: 100 });
    const spent = debitEnrich(granted.state, "c1");
    const next = rolloverPlan(spent.state, { grant: 100, grantRef: "in_2", expiryRef: "in_1-expire" });
    expect(next.applied).toBe(true);
    expect(next.state.balance).toBe(100);
    expect(next.state.planBalance).toBe(100);
  });

  it("refuses a vendor call at zero credits", () => {
    expect(canCallVendor(0)).toBe(false);
    expect(canCallVendor(1)).toBe(true);
  });
});

describe("credits in postgres", () => {
  let sql: Awaited<ReturnType<typeof testDatabase>>["sql"];

  beforeEach(async () => {
    ({ sql } = await testDatabase());
    await resetTables(sql);
  });

  afterAll(async () => {
    const db = await testDatabase();
    await db.sql.end({ timeout: 1 });
  });

  it("lets concurrent debits stop at zero and stay idempotent", async () => {
    const orgId = await insertOrg(sql, "Credits");
    await sql`UPDATE organizations SET credits_balance = 5, plan_credits_balance = 5 WHERE id = ${orgId}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => debitCredits(sql, orgId, 1, "enrich", `ref-${i}`)),
    );
    const applied = results.filter((row) => row.applied);
    expect(applied).toHaveLength(5);
    expect(Math.min(...results.map((row) => row.balance))).toBeGreaterThanOrEqual(0);
    const [org] = await sql<{ credits_balance: number }[]>`SELECT credits_balance FROM organizations WHERE id = ${orgId}`;
    expect(org!.credits_balance).toBe(0);
    const retry = await debitCredits(sql, orgId, 1, "enrich", "ref-0");
    expect(retry.applied).toBe(false);
    const [after] = await sql<{ credits_balance: number }[]>`SELECT credits_balance FROM organizations WHERE id = ${orgId}`;
    expect(after!.credits_balance).toBe(0);
    const calls = { n: 0 };
    const vendor = async () => {
      calls.n += 1;
      return "a@b.co";
    };
    if (canCallVendor(after!.credits_balance)) await vendor();
    expect(calls.n).toBe(0);
  });
});
