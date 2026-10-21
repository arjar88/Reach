import type { ActionStatus, ActionType } from "../config.js";
import { config } from "../config.js";
import { cleanFirstName } from "../names.js";
import type { ProfileView, UnipileClient } from "../providers/unipile.js";
import { ProviderError } from "../providers/http.js";
import {
  classifyProviderError,
  isFirstDegree,
  onInviteSent,
  onInviteSkippedConnected,
  onMessageSent,
  onReply,
  onStepFailed,
  onVisitDone,
  type ContactSnap,
  type FailureClass,
  type StepRef,
} from "../sequence.js";

export interface SendSeat {
  id: string;
  kind: "linkedin" | "email";
  unipileAccountId: string;
  unipileStatus: string;
  pausedReason: string | null;
  isPremium: boolean;
  silentVisits: boolean;
}

export interface SendAction {
  id: string;
  orgId: string;
  status: string;
  type: ActionType;
  attempts: number;
  content: string | null;
  subject: string | null;
  contact: ContactSnap & { profileUrl: string; name: string | null; linkedinChatId: string | null };
  steps: StepRef[];
  seat: SendSeat;
  suppressed: boolean;
  duplicateProvider: boolean;
  /** Prospect sent something after our last outbound. */
  replied: boolean;
}

export interface SendVendor {
  getProfile: UnipileClient["getProfile"];
  invite: UnipileClient["invite"];
  withdrawInvite: UnipileClient["withdrawInvite"];
  sendChat: UnipileClient["sendChat"];
  sendEmail: UnipileClient["sendEmail"];
}

export interface ProviderCallLog {
  route: string;
  statusCode: number | null;
  errorType: string | null;
}

export type SendOutcome =
  | { kind: "stopped"; calls: ProviderCallLog[] }
  | { kind: "deferred"; status: "ready"; reason: string; calls: ProviderCallLog[] }
  | { kind: "skipped"; contact: ContactSnap; reason: string; calls: ProviderCallLog[] }
  | { kind: "sent"; contact: ContactSnap; externalId: string | null; chatId: string | null; calls: ProviderCallLog[]; profile: ProfileView | null; firstNameClean: string | null }
  | { kind: "failure"; failure: FailureClass; contact: ContactSnap; calls: ProviderCallLog[] };

function log(route: string, statusCode: number | null, errorType: string | null): ProviderCallLog {
  return { route, statusCode, errorType };
}

/**
 * Send one claimed action. Status other than `sending` returns without calling the vendor,
 * so a retry or a reconcile that already marked the row sent cannot send twice.
 * Inbox replies are not created here.
 */
export async function executeSend(action: SendAction, vendor: SendVendor, opts: {
  nowIso: string;
  unsubscribeUrl?: string;
  replyTo?: string | null;
} ): Promise<SendOutcome> {
  if (action.status !== "sending") return { kind: "stopped", calls: [] };
  const seatDown = action.seat.pausedReason || action.seat.unipileStatus !== "OK";
  if (seatDown) return { kind: "deferred", status: "ready", reason: "seat_not_ok", calls: [] };
  if (action.suppressed) {
    return { kind: "skipped", contact: action.contact, reason: "suppressed", calls: [] };
  }
  if (action.type === "email" && action.contact.emailStatus === "bounced") {
    return { kind: "skipped", contact: onStepFailed(action.contact, action.steps, opts.nowIso).contact, reason: "bounced", calls: [] };
  }
  if (action.replied) {
    return { kind: "skipped", contact: onReply(action.contact).contact, reason: "replied", calls: [] };
  }

  try {
    if (action.type === "visit") {
      const profile = await vendor.getProfile(action.seat.unipileAccountId, action.contact.profileUrl, !action.seat.silentVisits);
      const transition = onVisitDone({
        contact: action.contact,
        steps: action.steps,
        nowIso: opts.nowIso,
        providerId: profile.providerId || null,
        networkDistance: profile.networkDistance,
        duplicateInOrg: action.duplicateProvider,
      });
      return {
        kind: "sent",
        contact: transition.contact,
        externalId: profile.providerId || null,
        chatId: action.contact.linkedinChatId,
        calls: [log("get_profile", 200, null)],
        profile,
        firstNameClean: visitFirstName(profile.firstName, action.contact.name),
      };
    }
    if (action.type === "invite") {
      if (isFirstDegree(action.contact.networkDistance)) {
        const transition = onInviteSkippedConnected(action.contact, action.steps, opts.nowIso);
        return { kind: "skipped", contact: transition.contact, reason: "already_connected", calls: [] };
      }
      if (!action.contact.providerId) {
        return { kind: "failure", failure: classifyProviderError({ errorType: "invalid_recipient", attempts: action.attempts }), contact: onStepFailed(action.contact, action.steps, opts.nowIso).contact, calls: [] };
      }
      const note = action.seat.isPremium ? (action.content?.slice(0, config.linkedin.inviteNoteMax) ?? null) : null;
      const sent = await vendor.invite(action.seat.unipileAccountId, action.contact.providerId, note);
      const transition = onInviteSent(action.contact, action.steps, opts.nowIso);
      return { kind: "sent", contact: transition.contact, externalId: sent.id, chatId: null, calls: [log("invite", 200, null)], profile: null, firstNameClean: null };
    }
    if (action.type === "withdraw") {
      if (!action.contact.providerId) {
        return { kind: "skipped", contact: action.contact, reason: "no_provider", calls: [] };
      }
      await vendor.withdrawInvite(action.seat.unipileAccountId, action.contact.providerId);
      return { kind: "sent", contact: action.contact, externalId: null, chatId: null, calls: [log("withdraw", 200, null)], profile: null, firstNameClean: null };
    }
    if (action.type === "message") {
      if (!action.contact.providerId || !action.content) {
        return { kind: "failure", failure: classifyProviderError({ errorType: "invalid_recipient", attempts: action.attempts }), contact: onStepFailed(action.contact, action.steps, opts.nowIso).contact, calls: [] };
      }
      const sent = await vendor.sendChat(action.seat.unipileAccountId, {
        providerId: action.contact.providerId,
        chatId: action.contact.linkedinChatId,
        text: action.content,
      });
      const transition = onMessageSent(action.contact, action.steps, opts.nowIso);
      return { kind: "sent", contact: transition.contact, externalId: sent.messageId, chatId: sent.chatId, calls: [log("send_message", 200, null)], profile: null, firstNameClean: null };
    }
    if (action.type === "email") {
      if (!action.contact.email || !action.content) {
        return { kind: "failure", failure: classifyProviderError({ errorType: "invalid_recipient", attempts: action.attempts }), contact: onStepFailed(action.contact, action.steps, opts.nowIso).contact, calls: [] };
      }
      const sent = await vendor.sendEmail(action.seat.unipileAccountId, {
        to: action.contact.email,
        subject: action.subject ?? "Hello",
        body: action.content,
        actionId: action.id,
        replyTo: opts.replyTo ?? null,
        unsubscribeUrl: opts.unsubscribeUrl ?? `${process.env.APP_URL ?? "http://localhost:3000"}/u/pending`,
      });
      const transition = onMessageSent(action.contact, action.steps, opts.nowIso);
      return { kind: "sent", contact: transition.contact, externalId: sent.trackingId, chatId: null, calls: [log("send_email", 200, null)], profile: null, firstNameClean: null };
    }
    return { kind: "skipped", contact: action.contact, reason: "unknown_type", calls: [] };
  } catch (error) {
    const failure = error instanceof ProviderError
      ? classifyProviderError({
        statusCode: error.statusCode,
        errorType: error.errorType,
        accountStatus: error.accountStatus ?? action.seat.unipileStatus,
        attempts: action.attempts,
        temporary: error.temporary,
      })
      : classifyProviderError({ errorType: "timeout", attempts: action.attempts, temporary: true });
    const contact = failure.kind === "permanent" || (failure.kind === "temporary" && failure.skipStep)
      ? onStepFailed(action.contact, action.steps, opts.nowIso).contact
      : action.contact;
    const errorType = error instanceof ProviderError ? (error.errorType ?? "error") : "timeout";
    const statusCode = error instanceof ProviderError ? (error.statusCode ?? null) : null;
    return { kind: "failure", failure, contact, calls: [log(action.type, statusCode, errorType)] };
  }
}

export function actionStatusAfter(outcome: SendOutcome): ActionStatus | null {
  if (outcome.kind === "stopped") return null;
  if (outcome.kind === "deferred") return "ready";
  if (outcome.kind === "skipped") return "skipped";
  if (outcome.kind === "sent") return "sent";
  return outcome.failure.actionStatus;
}

export function visitFirstName(profileFirst: string | null, contactName: string | null): string | null {
  return cleanFirstName(profileFirst ?? contactName);
}
