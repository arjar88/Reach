import { describe, expect, it } from "vitest";
import { pickCampaign, validateCampaign, validateEdit, type StepDraft } from "./campaigns.js";

const steps: StepDraft[] = [
  { position: 1, type: "visit", delayDays: 0, mode: "ai" },
  { position: 2, type: "invite", delayDays: 1, mode: "ai" },
  { position: 3, type: "message", delayDays: 1, mode: "fixed", template: "Hi {first_name}" },
  { position: 4, type: "message", delayDays: 2, mode: "ai" },
];

describe("campaigns", () => {
  it("allows a draft with LinkedIn steps and no seat", () => {
    expect(validateCampaign({ linkedinSeatId: null, emailSeatId: null, steps }, "save").ok).toBe(true);
  });

  it("rejects invalid activation", () => {
    expect(validateCampaign({ linkedinSeatId: null, emailSeatId: null, steps }, "activate").ok).toBe(false);
    const twoInvites = [...steps, { position: 5, type: "invite" as const, delayDays: 1, mode: "ai" as const }];
    expect(validateCampaign({ linkedinSeatId: "seat", emailSeatId: null, steps: twoInvites }, "activate").ok).toBe(false);
    const inviteAfter = [
      { position: 1, type: "message" as const, delayDays: 0, mode: "ai" as const },
      { position: 2, type: "invite" as const, delayDays: 1, mode: "ai" as const },
    ];
    expect(validateCampaign({ linkedinSeatId: "seat", emailSeatId: null, steps: inviteAfter }, "save").ok).toBe(false);
    const noVisit = [{ position: 1, type: "invite" as const, delayDays: 0, mode: "ai" as const }];
    expect(validateCampaign({ linkedinSeatId: "seat", emailSeatId: null, steps: noVisit }, "activate").ok).toBe(false);
    const noDelay = steps.map((step) => step.position === 2 ? { ...step, delayDays: 0 } : step);
    expect(validateCampaign({ linkedinSeatId: "seat", emailSeatId: null, steps: noDelay }, "activate").ok).toBe(false);
    const withEmail = [...steps, { position: 5, type: "email" as const, delayDays: 1, mode: "ai" as const }];
    expect(validateCampaign({ linkedinSeatId: "seat", emailSeatId: null, steps: withEmail }, "activate").ok).toBe(false);
  });

  it("activates a valid draft once a seat exists", () => {
    expect(validateCampaign({ linkedinSeatId: "seat", emailSeatId: null, steps }, "activate").ok).toBe(true);
  });

  it("locks structure after the first contact", () => {
    const changedType = steps.map((step) => step.position === 3 ? { ...step, type: "email" as const } : step);
    expect(validateEdit({ hasContacts: true, before: steps, after: changedType, seatChanged: false }).ok).toBe(false);
    expect(validateEdit({ hasContacts: true, before: steps, after: steps, seatChanged: true }).ok).toBe(false);
    const changedCopy = steps.map((step) => step.position === 3 ? { ...step, template: "Hello {first_name}", delayDays: 3 } : step);
    expect(validateEdit({ hasContacts: true, before: steps, after: changedCopy, seatChanged: false }).ok).toBe(true);
    expect(validateEdit({ hasContacts: false, before: steps, after: changedType, seatChanged: true }).ok).toBe(true);
  });

  it("assigns the active campaign with the fewest contacts", () => {
    const picked = pickCampaign([
      { id: "b", active: true, contactCount: 4 },
      { id: "a", active: true, contactCount: 4 },
      { id: "c", active: false, contactCount: 0 },
      { id: "d", active: true, contactCount: 9 },
    ]);
    expect(picked?.id).toBe("a");
    expect(pickCampaign([{ id: "c", active: false, contactCount: 0 }])).toBeNull();
  });
});
