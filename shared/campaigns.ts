import type { StepType } from "./config.js";

export interface StepDraft {
  position: number;
  type: StepType;
  delayDays: number;
  mode: "ai" | "fixed";
  template?: string | null;
  subject?: string | null;
}

export interface CampaignDraft {
  linkedinSeatId: string | null;
  emailSeatId: string | null;
  steps: StepDraft[];
}

export interface CampaignIssue {
  ok: false;
  errors: string[];
}

export type CampaignCheck = { ok: true } | CampaignIssue;

function sorted(steps: StepDraft[]): StepDraft[] {
  return [...steps].sort((a, b) => a.position - b.position);
}

/**
 * A draft may contain LinkedIn steps and a null seat.
 * Activate requires the seat, at most one invite, no invite after a message,
 * a delay on every step after the first, and a visit before any invite.
 */
export function validateCampaign(campaign: CampaignDraft, mode: "save" | "activate"): CampaignCheck {
  const errors: string[] = [];
  const steps = sorted(campaign.steps);
  if (steps.length === 0) errors.push("Add at least one step");
  const positions = new Set<number>();
  steps.forEach((step, index) => {
    if (positions.has(step.position)) errors.push(`Duplicate position ${step.position}`);
    positions.add(step.position);
    if (index > 0 && step.delayDays < 1) errors.push(`Step ${step.position} needs a delay of at least 1 day`);
    if (step.delayDays < 0) errors.push(`Step ${step.position} delay cannot be negative`);
  });
  const invites = steps.filter((s) => s.type === "invite");
  if (invites.length > 1) errors.push("A campaign can have at most one invite");
  const inviteAt = steps.findIndex((s) => s.type === "invite");
  if (inviteAt >= 0) {
    const visitAt = steps.findIndex((s) => s.type === "visit");
    if (visitAt < 0 || visitAt > inviteAt) errors.push("A visit is required before an invite");
    if (steps.slice(0, inviteAt).some((s) => s.type === "message" || s.type === "email")) {
      errors.push("An invite cannot come after a message");
    }
  }
  if (mode === "activate") {
    if (steps.some((s) => s.type !== "email") && !campaign.linkedinSeatId) {
      errors.push("Activate requires a LinkedIn seat");
    }
    if (steps.some((s) => s.type === "email") && !campaign.emailSeatId) {
      errors.push("Activate requires an email seat");
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

const LOCKED = new Set(["position", "type"]);

export function validateEdit(opts: {
  hasContacts: boolean;
  before: StepDraft[];
  after: StepDraft[];
  seatChanged: boolean;
}): CampaignCheck {
  if (!opts.hasContacts) return { ok: true };
  const errors: string[] = [];
  if (opts.seatChanged) errors.push("Duplicate as new campaign");
  const before = sorted(opts.before);
  const after = sorted(opts.after);
  if (before.length !== after.length) {
    errors.push("Duplicate as new campaign");
    return { ok: false, errors };
  }
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!;
    const b = after[i]!;
    for (const key of LOCKED) {
      if (a[key as "position" | "type"] !== b[key as "position" | "type"]) {
        errors.push("Duplicate as new campaign");
        return { ok: false, errors };
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Active campaign on the list with the fewest contacts. No cursor column. */
export function pickCampaign<T extends { id: string; active: boolean; contactCount: number }>(campaigns: T[]): T | null {
  const active = campaigns.filter((c) => c.active);
  if (active.length === 0) return null;
  return [...active].sort((a, b) => a.contactCount - b.contactCount || a.id.localeCompare(b.id))[0] ?? null;
}
