import { DateTime } from "luxon";
import type { ActionType, StepType } from "../config.js";
import { checkMessage, fillTemplate } from "../message-check.js";
import { buildSlots, windowState } from "../limits.js";
import { planEmailStep, type ContactSnap, type StepRef } from "../sequence.js";

export interface ReadyItem {
  id: string;
  contactId: string;
  type: ActionType;
  createdAt: string;
  content: string | null;
  subject: string | null;
}

export interface DueContact {
  contact: ContactSnap;
  step: StepRef & { id: string; mode: "ai" | "fixed"; template: string | null; subject: string | null };
  campaignId: string;
  fitScore: number;
  reviewMessages: boolean;
  language: string;
  firstName: string | null;
  company: string | null;
  title: string | null;
  hasOpenAction: boolean;
}

export interface PlanResult {
  planned: { contactId: string; stepId: string | null; actionId: string | null; type: ActionType; scheduledFor: string; content: string | null; subject: string | null }[];
  held: { contactId: string; stepId: string; type: StepType; content: string | null; subject: string | null; reason: string | null }[];
  enrich: string[];
  skippedOpen: string[];
  advances: { contactId: string; reason: string }[];
}

export async function planSeat(opts: {
  now: DateTime;
  zone: string;
  startHH: string;
  endHH: string;
  activeDays: number[];
  remaining: Record<ActionType | "total", number>;
  ready: ReadyItem[];
  due: DueContact[];
  rng?: () => number;
  write?: (due: DueContact) => Promise<{ subject?: string; body: string }>;
}): Promise<PlanResult> {
  const result: PlanResult = { planned: [], held: [], enrich: [], skippedOpen: [], advances: [] };
  const window = windowState({
    zone: opts.zone,
    instant: opts.now,
    startHH: opts.startHH,
    endHH: opts.endHH,
    activeDays: opts.activeDays,
  });
  if (!window.open) return result;
  const quotas = { ...opts.remaining };
  const totalSlots = Math.max(0, quotas.total);
  const slots = buildSlots({
    start: opts.now.setZone(opts.zone),
    end: window.end,
    count: totalSlots,
    rng: opts.rng,
  });
  let slotIndex = 0;
  const takeSlot = (type: ActionType): string | null => {
    // Withdrawals share the daily action budget and do not have a separate cap.
    const typeLeft = type === "withdraw" ? quotas.total : (quotas[type] ?? 0);
    if (typeLeft <= 0 || quotas.total <= 0) return null;
    const slot = slots[slotIndex];
    if (!slot) return null;
    slotIndex += 1;
    if (type !== "withdraw") quotas[type] = typeLeft - 1;
    quotas.total -= 1;
    return slot.toUTC().toISO()!;
  };

  const ready = [...opts.ready].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const item of ready) {
    if (item.type === "withdraw" || item.type === "visit") {
      const at = takeSlot(item.type);
      if (!at) continue;
      result.planned.push({ contactId: item.contactId, stepId: null, actionId: item.id, type: item.type, scheduledFor: at, content: item.content, subject: item.subject });
      continue;
    }
    const at = takeSlot(item.type);
    if (!at) continue;
    result.planned.push({ contactId: item.contactId, stepId: null, actionId: item.id, type: item.type, scheduledFor: at, content: item.content, subject: item.subject });
  }

  const groups = new Map<string, DueContact[]>();
  for (const due of opts.due) {
    if (due.hasOpenAction) {
      result.skippedOpen.push(due.contact.id);
      continue;
    }
    const list = groups.get(due.campaignId) ?? [];
    list.push(due);
    groups.set(due.campaignId, list);
  }
  for (const list of groups.values()) list.sort((a, b) => b.fitScore - a.fitScore);
  const campaignIds = [...groups.keys()].sort();
  const ordered: DueContact[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const id of campaignIds) {
      const next = groups.get(id)?.shift();
      if (next) {
        ordered.push(next);
        added = true;
      }
    }
  }

  for (const due of ordered) {
    if (due.step.type === "email") {
      const plan = planEmailStep(due.contact, opts.now.toUTC().toISO()!);
      if (plan.action === "enrich") {
        result.enrich.push(due.contact.id);
        continue;
      }
      if (plan.action === "wait") continue;
      if (plan.action === "skip") {
        result.advances.push({ contactId: due.contact.id, reason: plan.reason });
        continue;
      }
    }
    let content: string | null = null;
    let subject: string | null = due.step.subject;
    let failed: string | null = null;
    if (due.step.type !== "visit") {
      if (due.step.mode === "fixed") {
        const filled = fillTemplate(due.step.template ?? "", {
          firstName: due.firstName,
          company: due.company,
          title: due.title,
        });
        content = filled.body;
      } else {
        try {
          if (!opts.write) throw new Error("model_unavailable");
          const written = await opts.write(due);
          content = written.body;
          subject = written.subject ?? subject;
        } catch {
          // A model failure holds this action only. The rest of the seat continues.
          failed = "model_failed";
        }
      }
      if (!failed && content) {
        const check = checkMessage({
          kind: due.step.type === "invite" ? "invite" : due.step.type === "email" ? "email" : "message",
          body: content,
          subject: subject ?? undefined,
          template: due.step.template ?? "",
          language: due.language || "en",
        });
        if (!check.ok) failed = check.reason;
      } else if (!failed && !content) {
        failed = "empty";
      }
    }
    // review_messages holds invite notes and message text. Visits are never held.
    const hold = due.step.type !== "visit" && (due.reviewMessages || failed !== null);
    if (hold) {
      result.held.push({
        contactId: due.contact.id,
        stepId: due.step.id,
        type: due.step.type,
        content,
        subject,
        reason: failed,
      });
      continue;
    }
    const at = takeSlot(due.step.type);
    if (!at) continue;
    result.planned.push({
      contactId: due.contact.id,
      stepId: due.step.id,
      actionId: null,
      type: due.step.type,
      scheduledFor: at,
      content,
      subject,
    });
  }
  return result;
}
