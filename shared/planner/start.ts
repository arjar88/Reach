import type { Sql } from "postgres";
import { assignToCampaign } from "../sequence.js";
import { contactSnap, writeContact, type ContactRow } from "../sender/contact.js";

interface JobRow {
  id: string;
  org_id: string;
  payload: unknown;
}

interface CampaignPick {
  id: string;
  active: boolean;
  contactCount: number;
}

function campaignIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { campaignId?: unknown }).campaignId;
  return typeof value === "string" ? value : null;
}

/**
 * Assign approved contacts on the campaign's list to the active campaign with the
 * fewest contacts. has_contacts flips in the same transaction as the assignment.
 */
export async function runStartSequences(sql: Sql, now = new Date()): Promise<number> {
  const pending = await sql<{ id: string }[]>`
    SELECT id FROM job_requests
    WHERE type = 'start_sequences' AND status = 'pending'
    ORDER BY created_at
    LIMIT 50
  `;
  let done = 0;
  for (const job of pending) {
    const ran = await sql.begin(async (tx) => {
      const locked = await tx<JobRow[]>`
        SELECT id, org_id, payload FROM job_requests
        WHERE id = ${job.id} AND status = 'pending'
        FOR UPDATE SKIP LOCKED
      `;
      const row = locked[0];
      if (!row) return false;
      await assignApproved(tx as unknown as Sql, row, now.toISOString());
      await tx`
        UPDATE job_requests
        SET status = 'done', processed_at = now(), updated_at = now()
        WHERE id = ${row.id}
      `;
      return true;
    });
    if (ran) done += 1;
  }
  return done;
}

async function assignApproved(sql: Sql, job: JobRow, nowIso: string): Promise<void> {
  const requested = campaignIdOf(job.payload);
  const lists = requested
    ? await sql<{ list_id: string }[]>`
        SELECT list_id FROM campaigns WHERE id = ${requested} AND org_id = ${job.org_id}
      `
    : [];
  const listId = lists[0]?.list_id ?? null;
  const contacts = await sql<ContactRow[]>`
    SELECT id, org_id, status, campaign_id, current_step, next_step_at, provider_id,
           accepted_at, invited_at, email, email_status, email_hidden_at, rejected_reason,
           finished_reason, network_distance, country, profile_url, name, first_name_clean,
           title, company, linkedin_chat_id, fit_score
    FROM contacts
    WHERE org_id = ${job.org_id}
      AND status = 'approved'
      AND (${listId}::uuid IS NULL OR list_id = ${listId}::uuid)
  `;
  const campaigns = await sql<{ id: string; active: boolean; contact_count: number }[]>`
    SELECT c.id, c.active,
           (SELECT count(*)::int FROM contacts k WHERE k.campaign_id = c.id) AS contact_count
    FROM campaigns c
    WHERE c.org_id = ${job.org_id}
      AND (${listId}::uuid IS NULL OR c.list_id = ${listId}::uuid)
  `;
  const picks: CampaignPick[] = campaigns.map((row) => ({
    id: row.id,
    active: row.active,
    contactCount: row.contact_count,
  }));
  const touched = new Set<string>();
  for (const contact of contacts) {
    const before = contactSnap(contact);
    const transition = assignToCampaign(before, picks, nowIso);
    if (!transition.contact.campaignId || transition.contact.campaignId === before.campaignId && transition.contact.status === before.status) {
      continue;
    }
    const chosen = picks.find((item) => item.id === transition.contact.campaignId);
    if (chosen) chosen.contactCount += 1;
    await writeContact(sql, contact, transition.contact);
    for (const effect of transition.effects) {
      if (effect.type === "set_has_contacts") touched.add(effect.campaignId);
    }
  }
  for (const campaignId of touched) {
    await sql`
      UPDATE campaigns SET has_contacts = true, updated_at = now()
      WHERE id = ${campaignId} AND org_id = ${job.org_id}
    `;
  }
}
