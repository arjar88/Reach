import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  acceptanceGuardApplies,
  buildSlots,
  capAfterBlock,
  defaultActiveDays,
  effectiveWeeklyCap,
  inviteDailyCap,
  isActiveDay,
  localDayBounds,
  rampDailyCap,
  registerInviteLimitHit,
  remainingQuota,
  typeCap,
  validateSeatLimits,
  windowState,
} from "./limits.js";

const now = new Date("2026-10-21T12:00:00.000Z");

describe("limits", () => {
  it("counts sent, planned, sending, and unknown", () => {
    expect(remainingQuota(15, { sent: 2, planned: 1, sending: 1, unknown: 1 })).toBe(10);
    expect(remainingQuota(3, { sent: 3, planned: 0, sending: 0, unknown: 0 })).toBe(0);
  });

  it("ramps by week and by connection count", () => {
    const connected = new Date(now.getTime() - 3 * 86_400_000);
    expect(rampDailyCap({ connectedAt: connected, now, connections: 200, fullCap: 15 })).toBe(5);
    const week2 = new Date(now.getTime() - 10 * 86_400_000);
    expect(rampDailyCap({ connectedAt: week2, now, connections: 200, fullCap: 15 })).toBe(10);
    const later = new Date(now.getTime() - 20 * 86_400_000);
    expect(rampDailyCap({ connectedAt: later, now, connections: 200, fullCap: 15 })).toBe(15);
    expect(rampDailyCap({ connectedAt: later, now, connections: 100, fullCap: 15 })).toBe(5);
  });

  it("keeps the acceptance guard off under 100 invites", () => {
    expect(acceptanceGuardApplies(99, 0)).toBe(false);
    expect(acceptanceGuardApplies(100, 10)).toBe(true);
    expect(acceptanceGuardApplies(100, 30)).toBe(false);
  });

  it("applies a weekly cut with a floor and an expiry", () => {
    const future = new Date(now.getTime() + 86_400_000);
    const past = new Date(now.getTime() - 86_400_000);
    expect(effectiveWeeklyCap({ seatWeekly: 80, factor: 0.25, cutUntil: future, now })).toBe(40);
    expect(effectiveWeeklyCap({ seatWeekly: 30, factor: 0.5, cutUntil: future, now })).toBe(30);
    expect(effectiveWeeklyCap({ seatWeekly: 80, factor: 0.5, cutUntil: past, now })).toBe(80);
  });

  it("blocks a type for the local day when Postgres says the quota is zero", () => {
    expect(capAfterBlock(15, true)).toBe(0);
    expect(inviteDailyCap({
      seatDaily: 15,
      connectedAt: new Date(now.getTime() - 30 * 86_400_000),
      now,
      connections: 400,
      sampleSize: 10,
      accepted: 10,
      pausedUntil: null,
      blockedToday: true,
    })).toBe(0);
  });

  it("pauses invites after a two-day limit streak", () => {
    const zoneNow = DateTime.fromISO("2026-10-21T15:00:00", { zone: "Asia/Jerusalem" });
    const first = registerInviteLimitHit({ streak: 0, lastOn: null }, "2026-10-20", zoneNow);
    expect(first.streak).toBe(1);
    expect(first.pauseUntil).toBeNull();
    const second = registerInviteLimitHit({ streak: first.streak, lastOn: first.lastOn }, "2026-10-21", zoneNow);
    expect(second.streak).toBe(2);
    expect(second.pauseUntil).not.toBeNull();
    expect(second.nextFactor).toBe(0.8);
    expect(second.cutUntil).not.toBeNull();
  });

  it("uses the seat time zone for the local day, including the DST change", () => {
    const evening = DateTime.fromISO("2026-10-21T22:30:00Z");
    const jerusalem = localDayBounds("Asia/Jerusalem", evening).start.toISODate();
    const newYork = localDayBounds("America/New_York", evening).start.toISODate();
    expect(jerusalem).toBe("2026-10-22");
    expect(newYork).toBe("2026-10-21");
    const dst = DateTime.fromISO("2026-11-01T06:30:00", { zone: "America/New_York" });
    const bounds = localDayBounds("America/New_York", dst);
    expect(bounds.end.diff(bounds.start, "hours").hours).toBe(25);
  });

  it("uses Sunday–Thursday in Israel and Monday–Friday elsewhere", () => {
    const friday = DateTime.fromISO("2026-10-23T12:00:00", { zone: "Asia/Jerusalem" });
    const sunday = DateTime.fromISO("2026-10-25T12:00:00", { zone: "Asia/Jerusalem" });
    expect(isActiveDay("Asia/Jerusalem", friday, defaultActiveDays("IL"))).toBe(false);
    expect(isActiveDay("Asia/Jerusalem", sunday, defaultActiveDays("IL"))).toBe(true);
    expect(isActiveDay("America/New_York", friday.setZone("America/New_York"), defaultActiveDays("US"))).toBe(true);
    expect(isActiveDay("America/New_York", sunday.setZone("America/New_York"), defaultActiveDays("US"))).toBe(false);
  });

  it("keeps slots inside the window, 2–8 minutes apart", () => {
    const start = DateTime.fromISO("2026-10-21T09:00:00", { zone: "UTC" });
    const end = start.set({ hour: 17 });
    const slots = buildSlots({ start, end, count: 5, rng: () => 0 });
    expect(slots).toHaveLength(5);
    for (let i = 1; i < slots.length; i++) {
      const gap = slots[i]!.diff(slots[i - 1]!, "minutes").minutes;
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(8);
    }
    expect(slots.every((slot) => slot >= start && slot <= end)).toBe(true);
    const closed = windowState({
      zone: "UTC",
      instant: DateTime.fromISO("2026-10-21T18:00:00Z"),
      startHH: "09:00",
      endHH: "17:00",
      activeDays: [1, 2, 3, 4, 5],
    });
    expect(closed.open).toBe(false);
  });

  it("splits caps by seat type and rejects settings above the ceiling", () => {
    expect(typeCap("invite", { visit: 30, invite: 0, message: 40, email: 30, total: 70 })).toBe(0);
    expect(typeCap("message", { visit: 30, invite: 0, message: 40, email: 30, total: 70 })).toBe(40);
    expect(typeCap("email", { visit: 0, invite: 0, message: 0, email: 30, total: 70 })).toBe(30);
    expect(validateSeatLimits({ dailyInvites: 16 })).toContain("dailyInvites cannot exceed 15");
    expect(validateSeatLimits({ dailyInvites: 15, dailyEmail: 30 })).toEqual([]);
  });
});
