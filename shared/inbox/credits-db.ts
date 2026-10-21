import type { Sql } from "postgres";
import type { LedgerReason } from "../credits.js";
import { rolloverPlan, type CreditState, type LedgerEntry } from "../credits.js";

export interface LedgerResult {
  applied: boolean;
  balance: number;
  error?: "insufficient" | "duplicate";
}

function planDelta(reason: LedgerReason, amount: number): number {
  if (reason === "top_up") return 0;
  return amount;
}

/** Conditional balance update under a row lock. Balance cannot go below zero. */
export async function applyLedger(
  sql: Sql,
  orgId: string,
  entry: { reason: LedgerReason; refId: string; amount: number },
): Promise<LedgerResult> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ credits_balance: number; plan_credits_balance: number }[]>`
      SELECT credits_balance, plan_credits_balance
      FROM organizations
      WHERE id = ${orgId}
      FOR UPDATE
    `;
    const org = rows[0];
    if (!org) throw new Error("Organization not found");
    const balance = Number(org.credits_balance);
    const planBalance = Number(org.plan_credits_balance);
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM credit_ledger WHERE reason = ${entry.reason} AND ref_id = ${entry.refId}
    `;
    if (existing.length > 0) {
      return { applied: false, balance, error: "duplicate" as const };
    }
    if (entry.amount < 0 && balance + entry.amount < 0) {
      return { applied: false, balance, error: "insufficient" as const };
    }
    const nextPlan = Math.max(0, planBalance + planDelta(entry.reason, entry.amount));
    const nextBalance = balance + entry.amount;
    await tx`
      UPDATE organizations
      SET credits_balance = ${nextBalance},
          plan_credits_balance = ${nextPlan}
      WHERE id = ${orgId}
    `;
    await tx`
      INSERT INTO credit_ledger (org_id, amount, reason, ref_id)
      VALUES (${orgId}, ${entry.amount}, ${entry.reason}, ${entry.refId})
    `;
    return { applied: true, balance: nextBalance };
  });
}

export async function debitCredits(sql: Sql, orgId: string, refId: string, amount = 1): Promise<LedgerResult> {
  return applyLedger(sql, orgId, { reason: "enrich", refId, amount: -Math.abs(amount) });
}

export async function readCreditState(sql: Sql, orgId: string): Promise<CreditState> {
  const [org] = await sql<{ credits_balance: number; plan_credits_balance: number }[]>`
    SELECT credits_balance, plan_credits_balance FROM organizations WHERE id = ${orgId}
  `;
  const entries = await sql<LedgerEntry[]>`
    SELECT reason, ref_id AS "refId", amount FROM credit_ledger WHERE org_id = ${orgId}
  `;
  return {
    balance: Number(org?.credits_balance ?? 0),
    planBalance: Number(org?.plan_credits_balance ?? 0),
    entries: entries.map((e) => ({ reason: e.reason, refId: e.refId, amount: Number(e.amount) })),
  };
}

/** Expire unused plan credits, then grant the new period. Both ledger rows are idempotent. */
export async function grantPlanPeriod(
  sql: Sql,
  orgId: string,
  opts: { grant: number; grantRef: string; expiryRef: string },
): Promise<LedgerResult> {
  const state = await readCreditState(sql, orgId);
  if (state.entries.some((entry) => entry.reason === "plan_grant" && entry.refId === opts.grantRef)) {
    return { applied: false, balance: state.balance, error: "duplicate" };
  }
  const rolled = rolloverPlan(state, opts);
  if (state.planBalance > 0) {
    const unused = Math.min(state.planBalance, state.balance);
    if (unused > 0) await applyLedger(sql, orgId, { reason: "plan_expiry", refId: opts.expiryRef, amount: -unused });
  }
  return applyLedger(sql, orgId, { reason: "plan_grant", refId: opts.grantRef, amount: opts.grant }).then((result) => {
    if (!rolled.applied && rolled.error === "duplicate") return { ...result, error: result.error };
    return result;
  });
}
