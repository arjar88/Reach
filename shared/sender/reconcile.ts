import type { ActionType } from "../config.js";
import { config } from "../config.js";
import { plannedOverdue, sendingTimedOut } from "../sequence.js";

export interface VendorTrace {
  invites: { providerId: string; at: string }[];
  messages: { providerId: string; at: string }[];
  emails: { trackingId: string; at: string }[];
}

const SKEW_MS = 2 * 60_000;

/**
 * Match a crashed invite or message by Unipile provider id, action type, and a vendor timestamp
 * at or after the claim (minus a small skew). Anything else goes back to ready so it can send once.
 */
export function reconcileDecision(opts: {
  type: ActionType;
  providerId: string | null;
  trackingId: string | null;
  claimedAt: string;
  vendor: VendorTrace;
}): "sent" | "ready" {
  const since = Date.parse(opts.claimedAt) - SKEW_MS;
  const after = (at: string) => Date.parse(at) >= since;
  if (opts.type === "invite" && opts.providerId) {
    return opts.vendor.invites.some((row) => row.providerId === opts.providerId && after(row.at)) ? "sent" : "ready";
  }
  if (opts.type === "message" && opts.providerId) {
    return opts.vendor.messages.some((row) => row.providerId === opts.providerId && after(row.at)) ? "sent" : "ready";
  }
  if (opts.type === "email" && opts.trackingId) {
    return opts.vendor.emails.some((row) => row.trackingId === opts.trackingId && after(row.at)) ? "sent" : "ready";
  }
  if (opts.type === "visit") return "ready";
  return "ready";
}

export function nextStatusForStuck(opts: {
  status: string;
  claimedAt: string | null;
  scheduledFor: string | null;
  nowIso: string;
}): "unknown" | "ready" | null {
  if (opts.status === "sending" && opts.claimedAt && sendingTimedOut(opts.claimedAt, opts.nowIso)) return "unknown";
  if (opts.status === "planned" && opts.scheduledFor && plannedOverdue(opts.scheduledFor, opts.nowIso)) return "ready";
  return null;
}

export function unknownAfterMs(): number {
  return config.linkedin.unknownMinutes * 60_000;
}
