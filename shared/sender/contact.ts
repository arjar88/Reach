import type { Sql } from "postgres";
import type { ContactStatus, EmailStatus } from "../config.js";
import type { ContactSnap } from "../sequence.js";

export interface ContactRow {
  id: string;
  org_id: string;
  status: string;
  campaign_id: string | null;
  current_step: number | null;
  next_step_at: Date | string | null;
  provider_id: string | null;
  accepted_at: Date | string | null;
  invited_at: Date | string | null;
  email: string | null;
  email_status: string;
  email_hidden_at: Date | string | null;
  rejected_reason: string | null;
  finished_reason: string | null;
  network_distance: string | null;
  country: string | null;
  profile_url: string;
  name: string | null;
  first_name_clean: string | null;
  title: string | null;
  company: string | null;
  linkedin_chat_id: string | null;
  fit_score: number | null;
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function contactSnap(row: ContactRow): ContactSnap {
  return {
    id: row.id,
    status: row.status as ContactStatus,
    campaignId: row.campaign_id,
    currentStep: row.current_step,
    nextStepAt: iso(row.next_step_at),
    providerId: row.provider_id,
    acceptedAt: iso(row.accepted_at),
    invitedAt: iso(row.invited_at),
    email: row.email,
    emailStatus: row.email_status as EmailStatus,
    emailHiddenAt: iso(row.email_hidden_at),
    rejectedReason: row.rejected_reason,
    finishedReason: row.finished_reason,
    networkDistance: row.network_distance,
    country: row.country,
  };
}

/** Persist a contact transition. An existing provider id is never replaced. */
export async function writeContact(sql: Sql, before: ContactRow, contact: ContactSnap, extra: {
  firstNameClean?: string | null;
  chatId?: string | null;
} = {}): Promise<void> {
  const providerId = before.provider_id ?? contact.providerId;
  await sql`
    UPDATE contacts SET
      status = ${contact.status},
      campaign_id = ${contact.campaignId},
      current_step = ${contact.currentStep},
      next_step_at = ${contact.nextStepAt},
      provider_id = ${providerId},
      accepted_at = ${contact.acceptedAt},
      invited_at = ${contact.invitedAt},
      email = ${contact.email},
      email_status = ${contact.emailStatus},
      email_hidden_at = ${contact.emailHiddenAt},
      rejected_reason = ${contact.rejectedReason},
      finished_reason = ${contact.finishedReason},
      network_distance = ${contact.networkDistance},
      country = ${contact.country},
      first_name_clean = COALESCE(${extra.firstNameClean ?? null}, first_name_clean),
      linkedin_chat_id = COALESCE(${extra.chatId ?? null}, linkedin_chat_id),
      updated_at = now()
    WHERE id = ${contact.id}
  `;
}

export async function stopOpenActions(sql: Sql, contactId: string, exceptId: string | null): Promise<void> {
  await sql`
    UPDATE actions SET status = 'skipped', error = 'stopped', updated_at = now()
    WHERE contact_id = ${contactId}
      AND status IN ('pending_approval', 'ready', 'planned', 'sending', 'unknown')
      AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)
  `;
}
