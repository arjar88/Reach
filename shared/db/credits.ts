import type { Sql } from "postgres";

export interface DebitResult {
  applied: boolean;
  balance: number;
}

/** Conditional balance update plus a ledger unique on (reason, ref_id). Never goes below zero. */
export async function debitCredits(sql: Sql, orgId: string, amount: number, reason: string, refId: string): Promise<DebitResult> {
  if (amount < 1) throw new Error("debit amount must be positive");
  return sql.begin(async (tx) => {
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM credit_ledger WHERE reason = ${reason} AND ref_id = ${refId}
    `;
    if (existing.length > 0) {
      const [org] = await tx<{ credits_balance: number }[]>`
        SELECT credits_balance FROM organizations WHERE id = ${orgId}
      `;
      return { applied: false, balance: org?.credits_balance ?? 0 };
    }
    const updated = await tx<{ credits_balance: number }[]>`
      UPDATE organizations
      SET credits_balance = credits_balance - ${amount},
          plan_credits_balance = GREATEST(0, plan_credits_balance - ${amount})
      WHERE id = ${orgId} AND credits_balance >= ${amount}
      RETURNING credits_balance
    `;
    if (updated.length === 0) {
      const [org] = await tx<{ credits_balance: number }[]>`
        SELECT credits_balance FROM organizations WHERE id = ${orgId}
      `;
      return { applied: false, balance: org?.credits_balance ?? 0 };
    }
    await tx`
      INSERT INTO credit_ledger (org_id, amount, reason, ref_id)
      VALUES (${orgId}, ${-amount}, ${reason}, ${refId})
    `;
    return { applied: true, balance: updated[0]!.credits_balance };
  });
}
