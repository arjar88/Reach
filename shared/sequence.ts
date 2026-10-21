import type { ActionStatus, ContactStatus, EmailStatus, StepType } from "./config.js";
import { config } from "./config.js";
import { isBlockedCountry } from "./profiles.js";

export interface StepRef {
  position: number;
  type: StepType;
  delayDays: number;
}

export interface ContactSnap {
  id: string;
  status: ContactStatus;
  campaignId: string | null;
  currentStep: number | null;
  nextStepAt: string | null;
  providerId: string | null;
  acceptedAt: string | null;
  invitedAt: string | null;
  email: string | null;
  emailStatus: EmailStatus;
  emailHiddenAt: string | null;
  rejectedReason: string | null;
  finishedReason: string | null;
  networkDistance: string | null;
  country: string | null;
}

export type Effect =
  | { type: "seen_person"; signalKey: string; score: number | null }
  | { type: "stop_open_actions" }
  | { type: "delete_unsent_actions" }
  | { type: "org_suppression" }
  | { type: "global_suppression" }
  | { type: "delete_contact" }
  | { type: "keep_thread" }
  | { type: "enrich" }
  | { type: "debit_credit"; amount: number; reason: "enrich"; refId: string }
  | { type: "notify_owner_once" }
  | { type: "schedule_withdraw" }
  | { type: "skip_email_steps" }
  | { type: "duplicate" }
  | { type: "refresh_name" }
  | { type: "set_has_contacts"; campaignId: string }
  | { type: "noop"; reason: string };

export interface Transition {
  contact: ContactSnap;
  effects: Effect[];
}

const DAY = 86_400_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clone(contact: ContactSnap): ContactSnap {
  return { ...contact };
}

function unchanged(contact: ContactSnap, effects: Effect[] = []): Transition {
  return { contact: clone(contact), effects };
}

export function isFirstDegree(distance: string | null | undefined): boolean {
  if (!distance) return false;
  const value = distance.toUpperCase().replace(/[\s-]+/g, "_");
  return value === "FIRST_DEGREE" || value === "DISTANCE_1" || value === "1" || value === "CONNECTED";
}

function nextStep(steps: StepRef[], position: number | null): StepRef | undefined {
  return steps.find((s) => s.position === (position ?? 0) + 1);
}

function advance(contact: ContactSnap, steps: StepRef[], fromIso: string, applyDelay: boolean): ContactSnap {
  const next = nextStep(steps, contact.currentStep);
  if (!next) {
    return { ...contact, status: "finished", nextStepAt: null, finishedReason: contact.finishedReason ?? "completed" };
  }
  const at = applyDelay ? iso(Date.parse(fromIso) + next.delayDays * DAY) : fromIso;
  return { ...contact, status: "in_campaign", currentStep: next.position, nextStepAt: at };
}

export function routeScore(opts: {
  score: number;
  minScore: number;
  reviewMode: boolean;
  signalKey: string;
}): { kind: "seen"; score: number; signalKey: string } | { kind: "contact"; status: "pending_review" | "approved" } {
  if (opts.score < opts.minScore) return { kind: "seen", score: opts.score, signalKey: opts.signalKey };
  return { kind: "contact", status: opts.reviewMode ? "pending_review" : "approved" };
}

export function approveLead(contact: ContactSnap): Transition {
  if (contact.status === "rejected") return unchanged(contact, [{ type: "noop", reason: "rejected stays rejected" }]);
  if (contact.status !== "pending_review") return unchanged(contact);
  return { contact: { ...contact, status: "approved" }, effects: [] };
}

export function rejectLead(contact: ContactSnap, reason: string): Transition {
  if (contact.status === "rejected") return unchanged(contact, [{ type: "noop", reason: "rejected stays rejected" }]);
  return { contact: { ...contact, status: "rejected", rejectedReason: reason, nextStepAt: null }, effects: [] };
}

export function assignToCampaign(
  contact: ContactSnap,
  campaigns: { id: string; active: boolean; contactCount: number }[],
  nowIso: string,
): Transition {
  if (contact.status !== "approved") return unchanged(contact);
  const active = [...campaigns].filter((c) => c.active).sort((a, b) => a.contactCount - b.contactCount || a.id.localeCompare(b.id));
  const chosen = active[0];
  if (!chosen) return unchanged(contact);
  return {
    contact: {
      ...contact,
      status: "in_campaign",
      campaignId: chosen.id,
      currentStep: 1,
      nextStepAt: nowIso,
    },
    effects: [{ type: "set_has_contacts", campaignId: chosen.id }],
  };
}

export function onVisitDone(opts: {
  contact: ContactSnap;
  steps: StepRef[];
  nowIso: string;
  providerId: string | null;
  networkDistance: string | null;
  duplicateInOrg: boolean;
}): Transition {
  if (opts.duplicateInOrg) {
    return {
      contact: { ...opts.contact, status: "finished", nextStepAt: null, finishedReason: "duplicate" },
      effects: [{ type: "duplicate" }],
    };
  }
  const contact = {
    ...opts.contact,
    providerId: opts.providerId ?? opts.contact.providerId,
    networkDistance: opts.networkDistance,
  };
  return { contact: advance(contact, opts.steps, opts.nowIso, true), effects: [{ type: "refresh_name" }] };
}

export function onInviteSkippedConnected(contact: ContactSnap, steps: StepRef[], nowIso: string): Transition {
  return { contact: advance(contact, steps, nowIso, false), effects: [] };
}

/** Fast accept: if acceptedAt is already set, do not park the contact in awaiting_acceptance. */
export function onInviteSent(contact: ContactSnap, steps: StepRef[], nowIso: string): Transition {
  if (contact.acceptedAt) {
    const moved = advance({ ...contact, invitedAt: contact.invitedAt ?? nowIso, status: "in_campaign" }, steps, contact.acceptedAt, true);
    return { contact: moved, effects: [] };
  }
  return {
    contact: { ...contact, status: "awaiting_acceptance", nextStepAt: null, invitedAt: nowIso },
    effects: [],
  };
}

export function onAccepted(contact: ContactSnap, steps: StepRef[], acceptedAt: string): Transition {
  if (contact.status === "replied" || contact.status === "suppressed" || contact.status === "rejected") {
    return unchanged(contact);
  }
  if (contact.status === "finished" && contact.finishedReason !== "duplicate") return unchanged(contact);
  const current = steps.find((s) => s.position === contact.currentStep);
  if (contact.acceptedAt && contact.status === "in_campaign" && current?.type !== "invite") {
    return unchanged(contact);
  }
  const next = advance({ ...contact, acceptedAt, status: "in_campaign" }, steps, acceptedAt, true);
  return { contact: next, effects: [] };
}

export function onInviteTimeout(opts: {
  contact: ContactSnap;
  steps: StepRef[];
  nowIso: string;
  pending: boolean;
  connected: boolean;
}): Transition {
  if (!opts.pending && opts.connected) return onAccepted(opts.contact, opts.steps, opts.nowIso);
  const later = opts.steps.filter((s) => s.position > (opts.contact.currentStep ?? 0) && s.type === "email");
  const email = later[0];
  const effects: Effect[] = opts.pending ? [{ type: "schedule_withdraw" }] : [];
  if (!email) {
    return {
      contact: { ...opts.contact, status: "finished", nextStepAt: null, finishedReason: "invite_timeout" },
      effects,
    };
  }
  return {
    contact: {
      ...opts.contact,
      status: "in_campaign",
      currentStep: email.position,
      nextStepAt: iso(Date.parse(opts.nowIso) + email.delayDays * DAY),
    },
    effects,
  };
}

export function onMessageSent(contact: ContactSnap, steps: StepRef[], sentAt: string): Transition {
  return { contact: advance(contact, steps, sentAt, true), effects: [] };
}

export type EmailPlan =
  | { action: "send" }
  | { action: "enrich" }
  | { action: "wait" }
  | { action: "skip"; reason: string };

export function planEmailStep(contact: ContactSnap, nowIso: string, blocked: readonly string[] = config.email.blockedCountries): EmailPlan {
  if (contact.emailStatus === "bounced") return { action: "skip", reason: "bounced" };
  if (isBlockedCountry(contact.country, blocked)) return { action: "skip", reason: "country" };
  if (contact.email && contact.emailStatus !== "hidden" && contact.emailStatus !== "not_found") return { action: "send" };
  if (contact.emailStatus === "not_found") return { action: "skip", reason: "not_found" };
  if (contact.emailStatus === "hidden" && contact.emailHiddenAt) {
    const elapsed = Date.parse(nowIso) - Date.parse(contact.emailHiddenAt);
    if (elapsed >= config.email.hiddenWaitDays * DAY) return { action: "skip", reason: "no_credits" };
    return { action: "wait" };
  }
  if (!contact.email) return { action: "enrich" };
  return { action: "send" };
}

export function onNoCredits(contact: ContactSnap, nowIso: string): Transition {
  return {
    contact: { ...contact, emailStatus: "hidden", emailHiddenAt: contact.emailHiddenAt ?? nowIso },
    effects: contact.emailHiddenAt ? [] : [{ type: "notify_owner_once" }],
  };
}

export function onEnrichmentFound(contact: ContactSnap, email: string, nowIso: string): Transition & { debit: { amount: number; reason: "enrich"; refId: string } } {
  return {
    contact: {
      ...contact,
      email,
      emailStatus: "found",
      nextStepAt: nowIso,
    },
    effects: [{ type: "debit_credit", amount: 1, reason: "enrich", refId: contact.id }],
    debit: { amount: 1, reason: "enrich", refId: contact.id },
  };
}

export function onEnrichmentMiss(contact: ContactSnap, steps: StepRef[], nowIso: string): Transition {
  const skipped = advance({ ...contact, emailStatus: "not_found" }, steps, nowIso, true);
  return { contact: skipped, effects: [] };
}

export function onStepFailed(contact: ContactSnap, steps: StepRef[], nowIso: string): Transition {
  return { contact: advance(contact, steps, nowIso, true), effects: [] };
}

export function onReply(contact: ContactSnap): Transition {
  if (contact.status === "suppressed") return unchanged(contact);
  return {
    contact: { ...contact, status: "replied", nextStepAt: null },
    effects: [{ type: "stop_open_actions" }],
  };
}

export function onUnsubscribe(contact: ContactSnap): Transition {
  return {
    contact: { ...contact, status: "suppressed", nextStepAt: null },
    effects: [{ type: "org_suppression" }, { type: "stop_open_actions" }, { type: "keep_thread" }],
  };
}

export function onOptOut(contact: ContactSnap): Transition {
  return {
    contact,
    effects: [{ type: "global_suppression" }, { type: "delete_contact" }],
  };
}

export function onBounce(contact: ContactSnap): Transition {
  return {
    contact: { ...contact, emailStatus: "bounced" },
    effects: [{ type: "skip_email_steps" }],
  };
}

export function onCampaignDeactivated(contact: ContactSnap): Transition {
  return unchanged(contact, [{ type: "delete_unsent_actions" }]);
}

export function onCampaignReactivated(contact: ContactSnap): Transition {
  return unchanged(contact);
}

export function onCampaignDeleted(contact: ContactSnap): Transition {
  return { contact: { ...contact, status: "finished", nextStepAt: null, finishedReason: "campaign_deleted" }, effects: [] };
}

export function approveAction(status: ActionStatus): ActionStatus {
  if (status !== "pending_approval") return status;
  return "ready";
}

export function sendingTimedOut(claimedAt: string, nowIso: string): boolean {
  return Date.parse(nowIso) - Date.parse(claimedAt) >= config.linkedin.unknownMinutes * 60_000;
}

export function plannedOverdue(scheduledFor: string, nowIso: string): boolean {
  return Date.parse(nowIso) - Date.parse(scheduledFor) >= config.linkedin.overdueMinutes * 60_000;
}

export type FailureClass =
  | { kind: "limit"; actionStatus: "ready"; quotaZeroToday: true }
  | { kind: "temporary"; actionStatus: "ready" | "failed"; attempts: number; skipStep: boolean }
  | { kind: "permanent"; actionStatus: "failed"; skipStep: true }
  | { kind: "account"; actionStatus: "ready"; pauseSeat: true };

const LIMIT_TYPES = new Set(["cannot_resend_yet", "provider/too_many_requests", "too_many_requests"]);
const PERMANENT_TYPES = new Set(["cannot_invite_attendee", "already_invited_recently", "invalid_recipient"]);
const ACCOUNT_TYPES = new Set(["restricted", "CREDENTIALS", "PERMISSIONS", "credentials", "permissions"]);

export function classifyProviderError(input: {
  statusCode?: number;
  errorType?: string;
  accountStatus?: string;
  attempts: number;
  temporary?: boolean;
}): FailureClass {
  const errorType = input.errorType ?? "";
  const account = (input.accountStatus ?? "").toUpperCase();
  if (LIMIT_TYPES.has(errorType) || input.statusCode === 429) {
    return { kind: "limit", actionStatus: "ready", quotaZeroToday: true };
  }
  if (ACCOUNT_TYPES.has(errorType) || ACCOUNT_TYPES.has(account) || account === "CREDENTIALS" || account === "PERMISSIONS") {
    return { kind: "account", actionStatus: "ready", pauseSeat: true };
  }
  if (PERMANENT_TYPES.has(errorType)) {
    return { kind: "permanent", actionStatus: "failed", skipStep: true };
  }
  const temporary = input.temporary
    || (input.statusCode !== undefined && input.statusCode >= 500)
    || errorType === "timeout"
    || account === "CONNECTING";
  if (temporary) {
    const attempts = input.attempts + 1;
    if (attempts >= config.linkedin.maxAttempts) {
      return { kind: "temporary", actionStatus: "failed", attempts, skipStep: true };
    }
    return { kind: "temporary", actionStatus: "ready", attempts, skipStep: false };
  }
  return { kind: "permanent", actionStatus: "failed", skipStep: true };
}

export function blankContact(id: string, overrides: Partial<ContactSnap> = {}): ContactSnap {
  return {
    id,
    status: "approved",
    campaignId: null,
    currentStep: null,
    nextStepAt: null,
    providerId: null,
    acceptedAt: null,
    invitedAt: null,
    email: null,
    emailStatus: "unknown",
    emailHiddenAt: null,
    rejectedReason: null,
    finishedReason: null,
    networkDistance: null,
    country: null,
    ...overrides,
  };
}
