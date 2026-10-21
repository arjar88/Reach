import type { ActionType } from "../config.js";
import { reconcileDecision, type VendorTrace } from "./reconcile.js";
import {
  onInviteSent,
  onMessageSent,
  onVisitDone,
  type ContactSnap,
  type StepRef,
} from "../sequence.js";

export interface ReconcileInput {
  type: ActionType;
  providerId: string | null;
  trackingId: string | null;
  claimedAt: string;
  nowIso: string;
  contact: ContactSnap;
  steps: StepRef[];
  networkDistance: string | null;
  duplicateInOrg: boolean;
  vendor: VendorTrace;
}

/**
 * Decide whether a crashed send already landed. This never calls the vendor send methods.
 * A match marks the row sent and advances the contact. Anything else returns the action to ready
 * so the sender can try once, not twice.
 */
export function applyReconcile(input: ReconcileInput): { status: "sent" | "ready"; contact: ContactSnap } {
  const status = reconcileDecision({
    type: input.type,
    providerId: input.providerId,
    trackingId: input.trackingId,
    claimedAt: input.claimedAt,
    vendor: input.vendor,
  });
  if (status === "ready") return { status, contact: input.contact };
  if (input.type === "invite") {
    return { status: "sent", contact: onInviteSent(input.contact, input.steps, input.nowIso).contact };
  }
  if (input.type === "message" || input.type === "email") {
    return { status: "sent", contact: onMessageSent(input.contact, input.steps, input.nowIso).contact };
  }
  if (input.type === "visit") {
    return {
      status: "sent",
      contact: onVisitDone({
        contact: input.contact,
        steps: input.steps,
        nowIso: input.nowIso,
        providerId: input.providerId,
        networkDistance: input.networkDistance,
        duplicateInOrg: input.duplicateInOrg,
      }).contact,
    };
  }
  return { status: "sent", contact: input.contact };
}
