import { DateTime } from "luxon";
import { config } from "./config.js";
import type { ActionType } from "./config.js";

export interface UsageCounts {
  sent: number;
  planned: number;
  sending: number;
  unknown: number;
}

export function emptyUsage(): UsageCounts {
  return { sent: 0, planned: 0, sending: 0, unknown: 0 };
}

/** Quotas count sent, planned, sending, and unknown. */
export function usedCount(counts: UsageCounts): number {
  return counts.sent + counts.planned + counts.sending + counts.unknown;
}

export function remainingQuota(cap: number, counts: UsageCounts): number {
  return Math.max(0, cap - usedCount(counts));
}

export function localDayBounds(zone: string, instant: DateTime): { start: DateTime; end: DateTime } {
  const start = instant.setZone(zone).startOf("day");
  return { start, end: start.plus({ days: 1 }) };
}

export function windowBounds(
  zone: string,
  instant: DateTime,
  startHH: string,
  endHH: string,
): { start: DateTime; end: DateTime } {
  const [sh, sm] = startHH.split(":").map(Number);
  const [eh, em] = endHH.split(":").map(Number);
  const day = instant.setZone(zone).startOf("day");
  return {
    start: day.set({ hour: sh, minute: sm ?? 0, second: 0, millisecond: 0 }),
    end: day.set({ hour: eh, minute: em ?? 0, second: 0, millisecond: 0 }),
  };
}

/** Israel (IL): Sunday–Thursday. Everywhere else: Monday–Friday. Luxon weekday: Mon=1 … Sun=7. */
export function defaultActiveDays(country: string | null | undefined): number[] {
  if (country && ["IL", "ISRAEL"].includes(country.trim().toUpperCase())) return [7, 1, 2, 3, 4];
  return [1, 2, 3, 4, 5];
}

export function isActiveDay(zone: string, instant: DateTime, days: number[]): boolean {
  return days.includes(instant.setZone(zone).weekday);
}

export function windowState(opts: {
  zone: string;
  instant: DateTime;
  startHH: string;
  endHH: string;
  activeDays: number[];
}): { open: boolean; reason?: "inactive-day" | "before" | "after"; start: DateTime; end: DateTime } {
  const bounds = windowBounds(opts.zone, opts.instant, opts.startHH, opts.endHH);
  if (!isActiveDay(opts.zone, opts.instant, opts.activeDays)) {
    return { open: false, reason: "inactive-day", ...bounds };
  }
  const local = opts.instant.setZone(opts.zone);
  if (local < bounds.start) return { open: false, reason: "before", ...bounds };
  if (local >= bounds.end) return { open: false, reason: "after", ...bounds };
  return { open: true, ...bounds };
}

/**
 * Week 1 after first connection: 5. Week 2: 10. Then the seat cap.
 * Fewer than 150 connections stays on the week-1 cap.
 */
export function rampDailyCap(opts: {
  connectedAt: Date;
  now: Date;
  connections: number;
  fullCap: number;
}): number {
  const week1 = Math.min(config.linkedin.rampWeek1, opts.fullCap);
  if (opts.connections < config.linkedin.rampConnectionFloor) return week1;
  const weeks = Math.floor((opts.now.getTime() - opts.connectedAt.getTime()) / (7 * 86_400_000));
  if (weeks < 1) return week1;
  if (weeks < 2) return Math.min(config.linkedin.rampWeek2, opts.fullCap);
  return opts.fullCap;
}

/** Guard is off until 100 invites have been sampled. Under 20% accepted, the cap is halved. */
export function acceptanceGuardApplies(sampleSize: number, accepted: number): boolean {
  if (sampleSize < config.linkedin.acceptanceSample) return false;
  if (sampleSize <= 0) return false;
  return accepted / sampleSize < config.linkedin.acceptanceMinRate;
}

export function effectiveWeeklyCap(opts: {
  seatWeekly: number;
  factor: number;
  cutUntil: Date | null;
  now: Date;
}): number {
  const base = Math.min(opts.seatWeekly, config.linkedin.weeklyInvites);
  if (opts.cutUntil && opts.cutUntil > opts.now && opts.factor < 1) {
    const cut = Math.floor(base * opts.factor);
    return Math.min(base, Math.max(config.linkedin.weeklyCutFloor, cut));
  }
  return base;
}

export function inviteDailyCap(opts: {
  seatDaily: number;
  connectedAt: Date | null;
  now: Date;
  connections: number;
  sampleSize: number;
  accepted: number;
  pausedUntil: Date | null;
  blockedToday: boolean;
}): number {
  if (opts.blockedToday) return 0;
  if (opts.pausedUntil && opts.pausedUntil > opts.now) return 0;
  const ceiling = Math.min(opts.seatDaily, config.linkedin.dailyInvites);
  const ramped = opts.connectedAt
    ? rampDailyCap({ connectedAt: opts.connectedAt, now: opts.now, connections: opts.connections, fullCap: ceiling })
    : ceiling;
  const guarded = acceptanceGuardApplies(opts.sampleSize, opts.accepted) ? Math.floor(ramped * 0.5) : ramped;
  return Math.max(0, guarded);
}

export function capAfterBlock(cap: number, blockedToday: boolean): number {
  return blockedToday ? 0 : cap;
}

export interface LimitStreakState {
  streak: number;
  lastOn: string | null;
}

export interface LimitStreakResult {
  streak: number;
  lastOn: string;
  pauseUntil: Date | null;
  nextFactor: number | null;
  cutUntil: Date | null;
}

/** A two-day invite-limit streak pauses invites for 7 days and cuts the weekly cap. */
export function registerInviteLimitHit(state: LimitStreakState, today: string, now: DateTime): LimitStreakResult {
  if (state.lastOn === today) {
    return { streak: state.streak, lastOn: today, pauseUntil: null, nextFactor: null, cutUntil: null };
  }
  const yesterday = DateTime.fromISO(today, { zone: now.zone }).minus({ days: 1 }).toISODate();
  const streak = state.lastOn === yesterday ? state.streak + 1 : 1;
  if (streak >= config.linkedin.limitStreakDays) {
    return {
      streak,
      lastOn: today,
      pauseUntil: now.plus({ days: config.linkedin.invitePauseDays }).toJSDate(),
      nextFactor: config.linkedin.weeklyCutFactor,
      cutUntil: now.plus({ days: config.linkedin.weeklyCutDays }).toJSDate(),
    };
  }
  return { streak, lastOn: today, pauseUntil: null, nextFactor: null, cutUntil: null };
}

export function validateSeatLimits(input: {
  dailyInvites?: number;
  weeklyInvites?: number;
  dailyMessages?: number;
  dailyViews?: number;
  dailyActions?: number;
  dailyEmail?: number;
}): string[] {
  const errors: string[] = [];
  const checks: [string, number | undefined, number][] = [
    ["dailyInvites", input.dailyInvites, config.linkedin.dailyInvites],
    ["weeklyInvites", input.weeklyInvites, config.linkedin.weeklyInvites],
    ["dailyMessages", input.dailyMessages, config.linkedin.dailyMessages],
    ["dailyViews", input.dailyViews, config.linkedin.dailyViews],
    ["dailyActions", input.dailyActions, config.linkedin.dailyActions],
    ["dailyEmail", input.dailyEmail, config.email.dailyLimit],
  ];
  for (const [name, value, max] of checks) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) errors.push(`${name} cannot be negative`);
    else if (value > max) errors.push(`${name} cannot exceed ${max}`);
  }
  return errors;
}

export function buildSlots(opts: {
  start: DateTime;
  end: DateTime;
  count: number;
  rng?: () => number;
  minMinutes?: number;
  maxMinutes?: number;
}): DateTime[] {
  const rng = opts.rng ?? Math.random;
  const min = opts.minMinutes ?? config.linkedin.gapMinMinutes;
  const max = opts.maxMinutes ?? config.linkedin.gapMaxMinutes;
  const slots: DateTime[] = [];
  let cursor = opts.start;
  for (let i = 0; i < opts.count; i++) {
    const gap = min + Math.floor(rng() * (max - min + 1));
    const next = i === 0 ? cursor : cursor.plus({ minutes: gap });
    if (next > opts.end) break;
    slots.push(next);
    cursor = next;
  }
  return slots;
}

export function typeCap(type: ActionType, opts: {
  visit: number;
  invite: number;
  message: number;
  email: number;
  total: number;
}): number {
  if (type === "visit") return Math.min(opts.visit, opts.total);
  if (type === "invite") return Math.min(opts.invite, opts.total);
  if (type === "message") return Math.min(opts.message, opts.total);
  if (type === "email") return Math.min(opts.email, opts.total);
  return opts.total;
}

export function countInWindow(instants: Date[], start: Date, end: Date): number {
  return instants.filter((d) => d >= start && d < end).length;
}
