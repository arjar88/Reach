export type LedgerReason = "plan_grant" | "plan_expiry" | "top_up" | "enrich";

export interface LedgerEntry {
  reason: LedgerReason;
  refId: string;
  amount: number;
}

export interface CreditState {
  balance: number;
  planBalance: number;
  entries: LedgerEntry[];
}

export interface CreditResult {
  state: CreditState;
  applied: boolean;
  error?: "insufficient" | "duplicate";
}

function has(entries: LedgerEntry[], reason: LedgerReason, refId: string): boolean {
  return entries.some((e) => e.reason === reason && e.refId === refId);
}

/** Pure ledger. The database path is a conditional UPDATE plus a unique (reason, ref_id). */
export function applyEntry(state: CreditState, entry: LedgerEntry): CreditResult {
  if (has(state.entries, entry.reason, entry.refId)) {
    return { state, applied: false, error: "duplicate" };
  }
  if (entry.amount < 0 && state.balance + entry.amount < 0) {
    return { state, applied: false, error: "insufficient" };
  }
  const next: CreditState = {
    balance: state.balance + entry.amount,
    planBalance: state.planBalance,
    entries: [...state.entries, entry],
  };
  if (entry.reason === "plan_grant") next.planBalance += entry.amount;
  if (entry.reason === "plan_expiry") next.planBalance = Math.max(0, next.planBalance + entry.amount);
  if (entry.reason === "enrich" && entry.amount < 0) {
    const take = -entry.amount;
    next.planBalance = Math.max(0, next.planBalance - take);
  }
  return { state: next, applied: true };
}

export function debitEnrich(state: CreditState, refId: string, amount = 1): CreditResult {
  return applyEntry(state, { reason: "enrich", refId, amount: -amount });
}

/** New invoice: expire unused plan credits, then grant the new period. */
export function rolloverPlan(state: CreditState, opts: { grant: number; grantRef: string; expiryRef: string }): CreditResult {
  const unused = Math.max(0, Math.min(state.planBalance, state.balance));
  let current = state;
  if (unused > 0) {
    const expired = applyEntry(current, { reason: "plan_expiry", refId: opts.expiryRef, amount: -unused });
    if (!expired.applied && expired.error !== "duplicate") return expired;
    current = expired.applied ? expired.state : current;
  }
  return applyEntry(current, { reason: "plan_grant", refId: opts.grantRef, amount: opts.grant });
}

export function canCallVendor(balance: number): boolean {
  return balance >= 1;
}
