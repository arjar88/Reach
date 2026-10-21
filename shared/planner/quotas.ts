import { DateTime } from "luxon";
import type { ActionType } from "../config.js";
import { config } from "../config.js";
import {
  capAfterBlock,
  effectiveWeeklyCap,
  emptyUsage,
  inviteDailyCap,
  remainingQuota,
  type UsageCounts,
} from "../limits.js";

export interface SeatCaps {
  dailyInvites: number;
  weeklyInvites: number;
  dailyMessages: number;
  dailyViews: number;
  dailyActions: number;
  dailyEmail: number;
  connections: number;
  connectedAt: Date | null;
  pausedUntil: Date | null;
  weeklyFactor: number;
  weeklyCutUntil: Date | null;
  invitesSentSample: number;
  invitesAcceptedSample: number;
  weeklyInvitesSent: number;
}

/** Seat settings cannot exceed config ceilings. The numbers passed in are already the seat's stored values. */
export function linkedinQuotaRemaining(opts: {
  seat: SeatCaps;
  usage: Partial<Record<ActionType, UsageCounts>>;
  totalUsage: UsageCounts;
  blocked: Partial<Record<ActionType, boolean>>;
  now: Date;
}): Record<ActionType | "total", number> {
  const viewCap = Math.min(opts.seat.dailyViews, config.linkedin.dailyViews);
  const messageCap = Math.min(opts.seat.dailyMessages, config.linkedin.dailyMessages);
  const actionCap = Math.min(opts.seat.dailyActions, config.linkedin.dailyActions);
  const weekly = effectiveWeeklyCap({
    seatWeekly: opts.seat.weeklyInvites,
    factor: opts.seat.weeklyFactor,
    cutUntil: opts.seat.weeklyCutUntil,
    now: opts.now,
  });
  const dailyInvites = inviteDailyCap({
    seatDaily: opts.seat.dailyInvites,
    connectedAt: opts.seat.connectedAt,
    now: opts.now,
    connections: opts.seat.connections,
    sampleSize: opts.seat.invitesSentSample,
    accepted: opts.seat.invitesAcceptedSample,
    pausedUntil: opts.seat.pausedUntil,
    blockedToday: Boolean(opts.blocked.invite),
  });
  const weeklyLeft = Math.max(0, weekly - opts.seat.weeklyInvitesSent);
  const usage = (type: ActionType) => opts.usage[type] ?? emptyUsage();
  return {
    visit: capAfterBlock(remainingQuota(viewCap, usage("visit")), Boolean(opts.blocked.visit)),
    invite: Math.min(remainingQuota(dailyInvites, usage("invite")), weeklyLeft),
    message: capAfterBlock(remainingQuota(messageCap, usage("message")), Boolean(opts.blocked.message)),
    email: 0,
    withdraw: capAfterBlock(remainingQuota(actionCap, opts.totalUsage), Boolean(opts.blocked.withdraw)),
    total: remainingQuota(actionCap, opts.totalUsage),
  };
}

export function emailQuotaRemaining(cap: number, usage: UsageCounts, blockedToday: boolean): number {
  const ceiling = Math.min(cap, config.email.dailyLimit);
  return capAfterBlock(remainingQuota(ceiling, usage), blockedToday);
}

export function seatLocalDate(zone: string, now: DateTime): string {
  return now.setZone(zone).toISODate() ?? now.toISODate()!;
}
