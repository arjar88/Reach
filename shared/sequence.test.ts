import { describe, expect, it } from "vitest";
import {
  approveAction,
  approveLead,
  assignToCampaign,
  blankContact,
  classifyProviderError,
  onAccepted,
  onBounce,
  onCampaignDeactivated,
  onCampaignDeleted,
  onCampaignReactivated,
  onEnrichmentFound,
  onEnrichmentMiss,
  onInviteSent,
  onInviteSkippedConnected,
  onInviteTimeout,
  onMessageSent,
  onNoCredits,
  onOptOut,
  onReply,
  onStepFailed,
  onUnsubscribe,
  onVisitDone,
  planEmailStep,
  plannedOverdue,
  rejectLead,
  routeScore,
  sendingTimedOut,
  type StepRef,
} from "./sequence.js";

const now = "2026-10-21T12:00:00.000Z";
const steps: StepRef[] = [
  { position: 1, type: "visit", delayDays: 0 },
  { position: 2, type: "invite", delayDays: 1 },
  { position: 3, type: "message", delayDays: 1 },
  { position: 4, type: "message", delayDays: 2 },
  { position: 5, type: "email", delayDays: 1 },
];

function inCampaign(step = 1) {
  return blankContact("c1", { status: "in_campaign", campaignId: "camp", currentStep: step, nextStepAt: now });
}

describe("sequence", () => {
  it("routes a score into review, approved, or seen", () => {
    expect(routeScore({ score: 0.4, minScore: 0.7, reviewMode: true, signalKey: "k" }).kind).toBe("seen");
    expect(routeScore({ score: 0.9, minScore: 0.7, reviewMode: true, signalKey: "k" })).toMatchObject({ kind: "contact", status: "pending_review" });
    expect(routeScore({ score: 0.9, minScore: 0.7, reviewMode: false, signalKey: "k" })).toMatchObject({ status: "approved" });
  });

  it("keeps a rejected lead rejected", () => {
    const rejected = rejectLead(blankContact("c1", { status: "pending_review" }), "wrong fit");
    expect(rejected.contact.status).toBe("rejected");
    expect(rejected.contact.rejectedReason).toBe("wrong fit");
    expect(approveLead(rejected.contact).contact.status).toBe("rejected");
  });

  it("assigns the active campaign with the fewest contacts", () => {
    const waiting = assignToCampaign(blankContact("c1"), [], now);
    expect(waiting.contact.status).toBe("approved");
    const assigned = assignToCampaign(blankContact("c1"), [
      { id: "busy", active: true, contactCount: 3 },
      { id: "quiet", active: true, contactCount: 1 },
    ], now);
    expect(assigned.contact).toMatchObject({ status: "in_campaign", campaignId: "quiet", currentStep: 1, nextStepAt: now });
    expect(assigned.effects).toContainEqual({ type: "set_has_contacts", campaignId: "quiet" });
  });

  it("finishes a duplicate provider id in this org and advances a normal visit", () => {
    const duplicate = onVisitDone({
      contact: inCampaign(1),
      steps,
      nowIso: now,
      providerId: "ACoAA-other",
      networkDistance: "DISTANCE_2",
      duplicateInOrg: true,
    });
    expect(duplicate.contact.status).toBe("finished");
    expect(duplicate.contact.finishedReason).toBe("duplicate");
    expect(duplicate.contact.providerId).toBeNull();
    const visit = onVisitDone({
      contact: inCampaign(1),
      steps,
      nowIso: now,
      providerId: "ACoAA-1",
      networkDistance: "DISTANCE_2",
      duplicateInOrg: false,
    });
    expect(visit.contact.providerId).toBe("ACoAA-1");
    expect(visit.contact.currentStep).toBe(2);
    expect(Date.parse(visit.contact.nextStepAt!) - Date.parse(now)).toBe(86_400_000);
  });

  it("skips an invite when already connected and does not park a fast accept", () => {
    const skipped = onInviteSkippedConnected(inCampaign(2), steps, now);
    expect(skipped.contact.currentStep).toBe(3);
    expect(skipped.contact.nextStepAt).toBe(now);
    const fast = onInviteSent({ ...inCampaign(2), acceptedAt: now }, steps, now);
    expect(fast.contact.status).toBe("in_campaign");
    expect(fast.contact.status).not.toBe("awaiting_acceptance");
    expect(fast.contact.currentStep).toBe(3);
    const parked = onInviteSent(inCampaign(2), steps, now);
    expect(parked.contact.status).toBe("awaiting_acceptance");
    expect(parked.contact.nextStepAt).toBeNull();
  });

  it("records acceptance and distinguishes a 21-day pending invite from a late connection", () => {
    const accepted = onAccepted({ ...inCampaign(2), status: "awaiting_acceptance" }, steps, now);
    expect(accepted.contact.status).toBe("in_campaign");
    expect(accepted.contact.acceptedAt).toBe(now);
    expect(accepted.contact.currentStep).toBe(3);
    const pending = onInviteTimeout({ contact: inCampaign(2), steps, nowIso: now, pending: true, connected: false });
    expect(pending.effects).toContainEqual({ type: "schedule_withdraw" });
    expect(pending.contact.currentStep).toBe(5);
    const connected = onInviteTimeout({ contact: inCampaign(2), steps, nowIso: now, pending: false, connected: true });
    expect(connected.contact.acceptedAt).toBe(now);
    expect(connected.contact.currentStep).toBe(3);
    expect(connected.effects.some((effect) => effect.type === "schedule_withdraw")).toBe(false);
  });

  it("advances after a message and stops on reply", () => {
    const sent = onMessageSent(inCampaign(3), steps, now);
    expect(sent.contact.currentStep).toBe(4);
    const reply = onReply(inCampaign(3));
    expect(reply.contact.status).toBe("replied");
    expect(reply.effects).toContainEqual({ type: "stop_open_actions" });
    const late = onReply(blankContact("c1", { status: "finished" }));
    expect(late.contact.status).toBe("replied");
  });

  it("keeps the thread on unsubscribe and deletes the contact on opt-out", () => {
    const unsub = onUnsubscribe(inCampaign(3));
    expect(unsub.contact.status).toBe("suppressed");
    expect(unsub.effects).toContainEqual({ type: "keep_thread" });
    expect(unsub.effects.some((effect) => effect.type === "delete_contact")).toBe(false);
    const opt = onOptOut(inCampaign(3));
    expect(opt.effects).toContainEqual({ type: "global_suppression" });
    expect(opt.effects).toContainEqual({ type: "delete_contact" });
  });

  it("handles a missing email, a bounce, and enrichment", () => {
    expect(planEmailStep(inCampaign(5), now).action).toBe("enrich");
    expect(planEmailStep({ ...inCampaign(5), country: "IL" }, now)).toEqual({ action: "skip", reason: "country" });
    expect(planEmailStep({ ...inCampaign(5), email: "a@b.co", emailStatus: "found" }, now).action).toBe("send");
    const hiddenAt = new Date(Date.parse(now) - 8 * 86_400_000).toISOString();
    expect(planEmailStep({ ...inCampaign(5), emailStatus: "hidden", emailHiddenAt: hiddenAt }, now)).toEqual({ action: "skip", reason: "no_credits" });
    const recent = new Date(Date.parse(now) - 86_400_000).toISOString();
    expect(planEmailStep({ ...inCampaign(5), emailStatus: "hidden", emailHiddenAt: recent }, now).action).toBe("wait");
    const bounce = onBounce(inCampaign(5));
    expect(bounce.contact.emailStatus).toBe("bounced");
    const found = onEnrichmentFound(inCampaign(5), "a@b.co", now);
    expect(found.debit).toEqual({ amount: 1, reason: "enrich", refId: "c1" });
    expect(found.contact.emailStatus).toBe("found");
    expect(found.contact.nextStepAt).toBe(now);
    const missed = onEnrichmentMiss(inCampaign(5), steps, now);
    expect(missed.contact.emailStatus).toBe("not_found");
    expect(missed.contact.status).toBe("finished");
    const noCredits = onNoCredits(inCampaign(5), now);
    expect(noCredits.contact.emailStatus).toBe("hidden");
    expect(noCredits.effects).toContainEqual({ type: "notify_owner_once" });
    expect(onNoCredits(noCredits.contact, now).effects).toEqual([]);
  });

  it("skips a failed step and leaves the contact in place when a campaign pauses", () => {
    const failed = onStepFailed(inCampaign(3), steps, now);
    expect(failed.contact.currentStep).toBe(4);
    const before = inCampaign(3);
    const paused = onCampaignDeactivated(before);
    expect(paused.contact).toEqual(before);
    expect(paused.effects).toContainEqual({ type: "delete_unsent_actions" });
    expect(onCampaignReactivated(before).contact).toEqual(before);
    expect(onCampaignDeleted(before).contact.status).toBe("finished");
  });

  it("classifies each provider failure", () => {
    expect(classifyProviderError({ errorType: "cannot_resend_yet", attempts: 0 }).kind).toBe("limit");
    expect(classifyProviderError({ statusCode: 429, attempts: 0 }).kind).toBe("limit");
    expect(classifyProviderError({ errorType: "provider/too_many_requests", attempts: 0 })).toMatchObject({ quotaZeroToday: true, actionStatus: "ready" });
    expect(classifyProviderError({ errorType: "timeout", attempts: 0 })).toMatchObject({ kind: "temporary", actionStatus: "ready", attempts: 1 });
    expect(classifyProviderError({ statusCode: 503, attempts: 2 })).toMatchObject({ actionStatus: "failed", skipStep: true });
    expect(classifyProviderError({ accountStatus: "CONNECTING", attempts: 0 }).kind).toBe("temporary");
    expect(classifyProviderError({ errorType: "cannot_invite_attendee", attempts: 0 })).toMatchObject({ kind: "permanent", skipStep: true });
    expect(classifyProviderError({ errorType: "already_invited_recently", attempts: 0 }).kind).toBe("permanent");
    expect(classifyProviderError({ errorType: "invalid_recipient", attempts: 0 }).kind).toBe("permanent");
    expect(classifyProviderError({ errorType: "restricted", attempts: 0 })).toMatchObject({ kind: "account", pauseSeat: true });
    expect(classifyProviderError({ accountStatus: "CREDENTIALS", attempts: 0 }).kind).toBe("account");
    expect(classifyProviderError({ accountStatus: "PERMISSIONS", attempts: 0 }).kind).toBe("account");
  });

  it("moves actions through approval, unknown, and overdue", () => {
    expect(approveAction("pending_approval")).toBe("ready");
    expect(sendingTimedOut(now, new Date(Date.parse(now) + 11 * 60_000).toISOString())).toBe(true);
    expect(sendingTimedOut(now, new Date(Date.parse(now) + 5 * 60_000).toISOString())).toBe(false);
    expect(plannedOverdue(now, new Date(Date.parse(now) + 31 * 60_000).toISOString())).toBe(true);
  });
});
