import { DateTime } from "luxon";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "./config.js";
import { createDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { planSeat, type DueContact } from "./planner/plan.js";
import { ProviderError } from "./providers/http.js";
import { applyReconcile } from "./sender/apply.js";
import { claimDueActions } from "./sender/claim.js";
import { executeSend, type SendAction, type SendVendor } from "./sender/execute.js";
import { nextStatusForStuck } from "./sender/reconcile.js";
import { blankContact, classifyProviderError, type StepRef } from "./sequence.js";

const steps: StepRef[] = [
  { position: 1, type: "visit", delayDays: 0 },
  { position: 2, type: "invite", delayDays: 1 },
  { position: 3, type: "message", delayDays: 1 },
];

function due(partial: Partial<DueContact> & Pick<DueContact, "contact">): DueContact {
  return {
    step: { id: "step-1", position: 1, type: "visit", delayDays: 0, mode: "fixed", template: null, subject: null },
    campaignId: "camp-a",
    fitScore: 0.9,
    reviewMessages: false,
    language: "en",
    firstName: "Ada",
    company: "Acme",
    title: "VP",
    hasOpenAction: false,
    ...partial,
  };
}

function action(partial: Partial<SendAction> = {}): SendAction {
  return {
    id: "action-1",
    orgId: "org-1",
    status: "sending",
    type: "invite",
    attempts: 0,
    content: "Hello there, I wanted to connect with you today.",
    subject: null,
    contact: {
      ...blankContact("contact-1", { status: "in_campaign", currentStep: 2, providerId: "ACoAA1", campaignId: "camp-1" }),
      profileUrl: "https://www.linkedin.com/in/ada",
      name: "Ada",
      linkedinChatId: null,
    },
    steps,
    seat: {
      id: "seat-1",
      kind: "linkedin",
      unipileAccountId: "acc-1",
      unipileStatus: "OK",
      pausedReason: null,
      isPremium: true,
      silentVisits: false,
    },
    suppressed: false,
    duplicateProvider: false,
    replied: false,
    ...partial,
  };
}

function vendor(overrides: Partial<SendVendor> = {}): SendVendor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getProfile: async () => {
      calls.push("getProfile");
      return { providerId: "ACoAA1", networkDistance: "DISTANCE_2", firstName: "Ada", headline: null, title: null, company: null, country: null, profileUrl: null };
    },
    invite: async () => {
      calls.push("invite");
      return { id: "inv-1" };
    },
    withdrawInvite: async () => {
      calls.push("withdraw");
    },
    sendChat: async () => {
      calls.push("sendChat");
      return { chatId: "chat-1", messageId: "msg-1" };
    },
    sendEmail: async () => {
      calls.push("sendEmail");
      return { trackingId: "track-1", providerId: "mail-1" };
    },
    ...overrides,
  };
}

const now = DateTime.fromISO("2026-10-21T12:00:00", { zone: "UTC" });

describe("planner skips contacts with an open action", () => {
  it("does not plan a contact that already has pending, ready, planned, sending, or unknown work", async () => {
    const open = due({ contact: blankContact("open"), hasOpenAction: true });
    const free = due({
      contact: blankContact("free", { status: "in_campaign", currentStep: 1 }),
      fitScore: 0.5,
    });
    const result = await planSeat({
      now,
      zone: "UTC",
      startHH: "09:00",
      endHH: "17:00",
      activeDays: [1, 2, 3, 4, 5],
      remaining: { visit: 5, invite: 5, message: 5, email: 0, withdraw: 5, total: 5 },
      ready: [],
      due: [open, free],
      rng: () => 0,
    });
    expect(result.skippedOpen).toEqual(["open"]);
    expect(result.planned.map((row) => row.contactId)).toEqual(["free"]);
  });

  it("holds invite notes and messages when review is on, and still plans visits", async () => {
    const visit = due({ contact: blankContact("v", { status: "in_campaign", currentStep: 1 }) });
    const invite = due({
      contact: blankContact("i", { status: "in_campaign", currentStep: 2 }),
      campaignId: "camp-b",
      reviewMessages: true,
      step: { id: "step-2", position: 2, type: "invite", delayDays: 1, mode: "fixed", template: "Hi {first_name}", subject: null },
    });
    const result = await planSeat({
      now,
      zone: "UTC",
      startHH: "09:00",
      endHH: "17:00",
      activeDays: [3],
      remaining: { visit: 5, invite: 5, message: 5, email: 0, withdraw: 5, total: 5 },
      ready: [],
      due: [visit, invite],
      rng: () => 0,
    });
    expect(result.planned.map((row) => row.type)).toEqual(["visit"]);
    expect(result.held.map((row) => row.type)).toEqual(["invite"]);
    expect(result.held[0]?.content).toContain("Ada");
  });

  it("plans a withdrawal as a normal action inside the daily budget", async () => {
    const result = await planSeat({
      now,
      zone: "UTC",
      startHH: "09:00",
      endHH: "17:00",
      activeDays: [3],
      remaining: { visit: 0, invite: 0, message: 0, email: 0, withdraw: 2, total: 2 },
      ready: [{ id: "w1", contactId: "c1", type: "withdraw", createdAt: "2026-10-21T11:00:00.000Z", content: null, subject: null }],
      due: [],
      rng: () => 0,
    });
    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]?.type).toBe("withdraw");
    expect(result.planned[0]?.scheduledFor).toBeTruthy();
  });

  it("holds only the action whose model call failed", async () => {
    const first = due({
      contact: blankContact("bad", { status: "in_campaign", currentStep: 3 }),
      step: { id: "m1", position: 3, type: "message", delayDays: 1, mode: "ai", template: null, subject: null },
    });
    const second = due({
      contact: blankContact("good", { status: "in_campaign", currentStep: 1 }),
      campaignId: "camp-b",
    });
    const result = await planSeat({
      now,
      zone: "UTC",
      startHH: "09:00",
      endHH: "17:00",
      activeDays: [3],
      remaining: { visit: 5, invite: 0, message: 5, email: 0, withdraw: 5, total: 5 },
      ready: [],
      due: [first, second],
      rng: () => 0,
      write: async (row) => {
        if (row.contact.id === "bad") throw new Error("model down");
        return { body: "Hello from the model, I wanted to talk with you about your work." };
      },
    });
    expect(result.held.map((row) => row.contactId)).toEqual(["bad"]);
    expect(result.held[0]?.reason).toBe("model_failed");
    expect(result.planned.map((row) => row.contactId)).toEqual(["good"]);
  });
});

describe("idempotent send", () => {
  it("calls the vendor once while sending and not again after the row is sent", async () => {
    const unipile = vendor();
    const first = await executeSend(action(), unipile, { nowIso: now.toISO()! });
    expect(first.kind).toBe("sent");
    expect(unipile.calls).toEqual(["invite"]);
    const second = await executeSend(action({ status: "sent" }), unipile, { nowIso: now.toISO()! });
    expect(second.kind).toBe("stopped");
    expect(unipile.calls).toEqual(["invite"]);
  });
});

describe("crash mid-send reconciles without a second send", () => {
  it("marks a timed-out invite unknown, matches the vendor timestamp, and does not invite again", async () => {
    const claimedAt = "2026-10-21T12:00:00.000Z";
    const landed: { providerId: string; at: string }[] = [];
    let invites = 0;
    const unipile = vendor({
      invite: async () => {
        invites += 1;
        landed.push({ providerId: "ACoAA1", at: claimedAt });
        throw new Error("worker killed");
      },
    });
    const crashed = await executeSend(action(), unipile, { nowIso: claimedAt });
    expect(crashed.kind).toBe("failure");
    expect(invites).toBe(1);
    const stuck = nextStatusForStuck({
      status: "sending",
      claimedAt,
      scheduledFor: null,
      nowIso: "2026-10-21T12:11:00.000Z",
    });
    expect(stuck).toBe("unknown");
    const reconciled = applyReconcile({
      type: "invite",
      providerId: "ACoAA1",
      trackingId: null,
      claimedAt,
      nowIso: "2026-10-21T12:11:00.000Z",
      contact: action().contact,
      steps,
      networkDistance: null,
      duplicateInOrg: false,
      vendor: { invites: landed, messages: [], emails: [] },
    });
    expect(reconciled.status).toBe("sent");
    expect(reconciled.contact.status).toBe("awaiting_acceptance");
    const replay = await executeSend(action({ status: "sent" }), unipile, { nowIso: "2026-10-21T12:11:00.000Z" });
    expect(replay.kind).toBe("stopped");
    expect(invites).toBe(1);
  });

  it("returns an unknown invite to ready when Unipile has no matching timestamp", () => {
    const reconciled = applyReconcile({
      type: "invite",
      providerId: "ACoAA1",
      trackingId: null,
      claimedAt: "2026-10-21T12:00:00.000Z",
      nowIso: "2026-10-21T12:11:00.000Z",
      contact: action().contact,
      steps,
      networkDistance: null,
      duplicateInOrg: false,
      vendor: { invites: [{ providerId: "ACoAA1", at: "2026-10-01T00:00:00.000Z" }], messages: [], emails: [] },
    });
    expect(reconciled.status).toBe("ready");
  });
});

describe("overdue planned actions", () => {
  it("moves a planned action back to ready after 30 minutes", () => {
    expect(nextStatusForStuck({
      status: "planned",
      claimedAt: null,
      scheduledFor: "2026-10-21T11:00:00.000Z",
      nowIso: "2026-10-21T11:31:00.000Z",
    })).toBe("ready");
    expect(nextStatusForStuck({
      status: "planned",
      claimedAt: null,
      scheduledFor: "2026-10-21T11:20:00.000Z",
      nowIso: "2026-10-21T11:31:00.000Z",
    })).toBeNull();
  });
});

describe("failures table", () => {
  const rows: { name: string; input: Parameters<typeof classifyProviderError>[0]; kind: string; status: string; skip?: boolean; pause?: boolean; quota?: boolean }[] = [
    { name: "cannot_resend_yet", input: { errorType: "cannot_resend_yet", attempts: 0 }, kind: "limit", status: "ready", quota: true },
    { name: "429", input: { statusCode: 429, attempts: 0 }, kind: "limit", status: "ready", quota: true },
    { name: "too_many_requests", input: { errorType: "provider/too_many_requests", attempts: 0 }, kind: "limit", status: "ready", quota: true },
    { name: "timeout", input: { errorType: "timeout", attempts: 0, temporary: true }, kind: "temporary", status: "ready" },
    { name: "500", input: { statusCode: 502, attempts: 1, temporary: true }, kind: "temporary", status: "ready" },
    { name: "CONNECTING", input: { accountStatus: "CONNECTING", attempts: 0 }, kind: "temporary", status: "ready" },
    { name: "third temporary", input: { errorType: "timeout", attempts: 2, temporary: true }, kind: "temporary", status: "failed", skip: true },
    { name: "cannot_invite_attendee", input: { errorType: "cannot_invite_attendee", attempts: 0 }, kind: "permanent", status: "failed", skip: true },
    { name: "already_invited_recently", input: { errorType: "already_invited_recently", attempts: 0 }, kind: "permanent", status: "failed", skip: true },
    { name: "invalid_recipient", input: { errorType: "invalid_recipient", attempts: 0 }, kind: "permanent", status: "failed", skip: true },
    { name: "restricted", input: { errorType: "restricted", attempts: 0 }, kind: "account", status: "ready", pause: true },
    { name: "CREDENTIALS", input: { accountStatus: "CREDENTIALS", attempts: 0 }, kind: "account", status: "ready", pause: true },
    { name: "PERMISSIONS", input: { accountStatus: "PERMISSIONS", attempts: 0 }, kind: "account", status: "ready", pause: true },
  ];

  it.each(rows)("$name → $kind / $status", (row) => {
    const failure = classifyProviderError(row.input);
    expect(failure.kind).toBe(row.kind);
    expect(failure.actionStatus).toBe(row.status);
    if (row.quota) expect(failure).toMatchObject({ quotaZeroToday: true });
    if (row.pause) expect(failure).toMatchObject({ pauseSeat: true });
    if (row.skip) expect(failure).toMatchObject({ skipStep: true });
    if (row.kind === "temporary" && !row.skip) expect(failure).toMatchObject({ attempts: row.input.attempts + 1, skipStep: false });
  });

  it("applies a limit error as ready without skipping the contact", async () => {
    const unipile = vendor({
      invite: async () => {
        throw new ProviderError("invite", "slow down", { statusCode: 429, errorType: "cannot_resend_yet" });
      },
    });
    const outcome = await executeSend(action(), unipile, { nowIso: now.toISO()! });
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure.kind).toBe("limit");
    expect(outcome.failure.actionStatus).toBe("ready");
    expect(outcome.contact.status).toBe("in_campaign");
    expect(outcome.calls[0]?.route).toBe("invite");
  });

  it("skips the step after a permanent recipient error", async () => {
    const unipile = vendor({
      invite: async () => {
        throw new ProviderError("invite", "nope", { statusCode: 422, errorType: "cannot_invite_attendee" });
      },
    });
    const outcome = await executeSend(action(), unipile, { nowIso: now.toISO()! });
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure.actionStatus).toBe("failed");
    expect(outcome.contact.currentStep).toBe(3);
  });

  it(`pauses the seat on CREDENTIALS and keeps the action ready`, async () => {
    const unipile = vendor({
      invite: async () => {
        throw new ProviderError("invite", "auth", { statusCode: 401, errorType: "CREDENTIALS", accountStatus: "CREDENTIALS" });
      },
    });
    const outcome = await executeSend(action(), unipile, { nowIso: now.toISO()! });
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure).toMatchObject({ kind: "account", pauseSeat: true, actionStatus: "ready" });
  });
});

describe("one claim per seat", () => {
  const url = process.env.DATABASE_URL_SESSION ?? "postgres://reach:reach@127.0.0.1:5432/reach_test";
  const { sql } = createDb(url, "worker");

  afterAll(async () => {
    await sql.end();
  });

  it("claims the oldest planned action on each seat and will not claim a second while one is sending", async () => {
    await migrate(url);
    const orgId = "00000000-0000-4000-8000-0000000000a1";
    const userId = "00000000-0000-4000-8000-0000000000a2";
    const listId = "00000000-0000-4000-8000-0000000000a3";
    const seatA = "00000000-0000-4000-8000-0000000000b1";
    const seatB = "00000000-0000-4000-8000-0000000000b2";
    const contactA = "00000000-0000-4000-8000-0000000000c1";
    const contactB = "00000000-0000-4000-8000-0000000000c2";
    const contactC = "00000000-0000-4000-8000-0000000000c3";
    await sql`DELETE FROM organizations WHERE id = ${orgId}`;
    await sql`
      INSERT INTO organizations (id, name) VALUES (${orgId}, 'sender-test')
    `;
    await sql`
      INSERT INTO users (id, org_id, email, role) VALUES (${userId}, ${orgId}, 'sender@reach.test', 'owner')
    `;
    await sql`INSERT INTO lists (id, org_id, name) VALUES (${listId}, ${orgId}, 'List')`;
    await sql`
      INSERT INTO linkedin_seats (id, org_id, user_id, unipile_account_id, linkedin_provider_id, unipile_status, timezone)
      VALUES
        (${seatA}, ${orgId}, ${userId}, 'uni-a', 'prov-a', 'OK', 'UTC'),
        (${seatB}, ${orgId}, ${userId}, 'uni-b', 'prov-b', 'OK', 'UTC')
    `;
    await sql`
      INSERT INTO contacts (id, org_id, list_id, profile_url, status)
      VALUES
        (${contactA}, ${orgId}, ${listId}, 'https://www.linkedin.com/in/a', 'in_campaign'),
        (${contactB}, ${orgId}, ${listId}, 'https://www.linkedin.com/in/b', 'in_campaign'),
        (${contactC}, ${orgId}, ${listId}, 'https://www.linkedin.com/in/c', 'in_campaign')
    `;
    await sql`
      INSERT INTO actions (org_id, contact_id, source, type, linkedin_seat_id, status, scheduled_for)
      VALUES
        (${orgId}, ${contactA}, 'sequence', 'visit', ${seatA}, 'planned', now() - interval '5 minutes'),
        (${orgId}, ${contactB}, 'sequence', 'visit', ${seatA}, 'planned', now() - interval '1 minute'),
        (${orgId}, ${contactC}, 'sequence', 'visit', ${seatB}, 'planned', now() - interval '2 minutes')
    `;
    const first = await claimDueActions(sql);
    expect(first).toHaveLength(2);
    const sending = await sql<{ linkedin_seat_id: string; status: string }[]>`
      SELECT linkedin_seat_id, status FROM actions WHERE org_id = ${orgId} AND status = 'sending'
    `;
    expect(new Set(sending.map((row) => row.linkedin_seat_id)).size).toBe(2);
    const second = await claimDueActions(sql);
    expect(second).toHaveLength(0);
    const stillPlanned = await sql<{ id: string }[]>`
      SELECT id FROM actions WHERE org_id = ${orgId} AND linkedin_seat_id = ${seatA} AND status = 'planned'
    `;
    expect(stillPlanned).toHaveLength(1);
    await sql`DELETE FROM organizations WHERE id = ${orgId}`;
    expect(config.workerPoolMax).toBe(8);
  });
});
