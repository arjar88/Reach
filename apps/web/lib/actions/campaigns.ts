"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { validateCampaign, validateEdit, type StepDraft } from "../../../../shared/campaigns.js";
import { DEACTIVATE_DELETE_STATUSES } from "../../../../shared/config.js";
import { approveAction } from "../../../../shared/sequence.js";
import { database } from "../db.js";
import { currentOrg } from "../session.js";

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function stepsFrom(form: FormData): StepDraft[] {
  const steps: StepDraft[] = [];
  for (let position = 1; position <= 6; position += 1) {
    const type = text(form, `type_${position}`);
    if (!type) continue;
    const mode = text(form, `mode_${position}`) === "fixed" ? "fixed" : "ai";
    steps.push({
      position,
      type: type as StepDraft["type"],
      delayDays: Number(text(form, `delay_${position}`) || "0"),
      mode,
      template: text(form, `template_${position}`) || null,
      subject: text(form, `subject_${position}`) || null,
    });
  }
  return steps;
}

async function fail(path: string, errors: string[]): Promise<never> {
  redirect(`${path}?error=${encodeURIComponent(errors.join(". "))}`);
}

export async function saveCampaign(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) await fail("/campaigns", [auth.error]);
  if ("error" in auth) return;
  const { sql } = database();
  const id = text(form, "id");
  const name = text(form, "name");
  const listId = text(form, "listId");
  const newList = text(form, "newList");
  const linkedinSeatId = text(form, "linkedinSeatId") || null;
  const emailSeatId = text(form, "emailSeatId") || null;
  const steps = stepsFrom(form);
  if (!name) await fail(id ? `/campaigns/${id}` : "/campaigns", ["Name is required"]);
  let resolvedList = listId;
  if (!resolvedList && newList) {
    const created = await sql<{ id: string }[]>`
      INSERT INTO lists (org_id, name) VALUES (${auth.orgId}, ${newList}) RETURNING id
    `;
    resolvedList = created[0]?.id ?? "";
  }
  if (!resolvedList) await fail(id ? `/campaigns/${id}` : "/campaigns", ["Pick a list"]);

  const existing = id
    ? (await sql<{ has_contacts: boolean; linkedin_seat_id: string | null; email_seat_id: string | null }[]>`
        SELECT has_contacts, linkedin_seat_id, email_seat_id FROM campaigns
        WHERE id = ${id} AND org_id = ${auth.orgId}
      `)[0]
    : null;
  if (id && !existing) await fail("/campaigns", ["Campaign not found"]);

  const beforeSteps = id
    ? await sql<{ position: number; type: StepDraft["type"]; delay_days: number; mode: "ai" | "fixed"; template: string | null; subject: string | null }[]>`
        SELECT position, type, delay_days, mode, template, subject
        FROM campaign_steps WHERE campaign_id = ${id} AND org_id = ${auth.orgId}
        ORDER BY position
      `
    : [];
  const before: StepDraft[] = beforeSteps.map((step) => ({
    position: step.position,
    type: step.type,
    delayDays: step.delay_days,
    mode: step.mode,
    template: step.template,
    subject: step.subject,
  }));

  if (existing?.has_contacts) {
    const edit = validateEdit({
      hasContacts: true,
      before,
      after: steps,
      seatChanged: existing.linkedin_seat_id !== linkedinSeatId || existing.email_seat_id !== emailSeatId,
    });
    if (!edit.ok) await fail(`/campaigns/${id}`, edit.errors);
    await sql`
      UPDATE campaigns SET
        name = ${name},
        goal = ${text(form, "goal") || "conversations"},
        tone = ${text(form, "tone") || "professional"},
        language = ${text(form, "language") || "en"},
        review_messages = ${form.get("reviewMessages") === "on"},
        silent_visits = ${form.get("silentVisits") === "on"},
        updated_at = now()
      WHERE id = ${id} AND org_id = ${auth.orgId}
    `;
    for (const step of steps) {
      await sql`
        UPDATE campaign_steps SET
          delay_days = ${step.delayDays},
          mode = ${step.mode},
          template = ${step.template ?? null},
          subject = ${step.subject ?? null},
          updated_at = now()
        WHERE campaign_id = ${id} AND org_id = ${auth.orgId} AND position = ${step.position}
      `;
    }
  } else {
    const check = validateCampaign({ linkedinSeatId, emailSeatId, steps }, "save");
    if (!check.ok) await fail(id ? `/campaigns/${id}` : "/campaigns", check.errors);
    const campaignId = id || (await sql<{ id: string }[]>`
      INSERT INTO campaigns (
        org_id, list_id, name, linkedin_seat_id, email_seat_id, goal, tone, language,
        review_messages, silent_visits, active, has_contacts
      ) VALUES (
        ${auth.orgId}, ${resolvedList}, ${name}, ${linkedinSeatId}, ${emailSeatId},
        ${text(form, "goal") || "conversations"}, ${text(form, "tone") || "professional"},
        ${text(form, "language") || "en"}, ${form.get("reviewMessages") === "on"},
        ${form.get("silentVisits") === "on"}, false, false
      ) RETURNING id
    `)[0]?.id;
    if (!campaignId) await fail("/campaigns", ["Could not save the campaign"]);
    if (id) {
      await sql`
        UPDATE campaigns SET
          list_id = ${resolvedList}, name = ${name}, linkedin_seat_id = ${linkedinSeatId},
          email_seat_id = ${emailSeatId}, goal = ${text(form, "goal") || "conversations"},
          tone = ${text(form, "tone") || "professional"}, language = ${text(form, "language") || "en"},
          review_messages = ${form.get("reviewMessages") === "on"},
          silent_visits = ${form.get("silentVisits") === "on"}, updated_at = now()
        WHERE id = ${id} AND org_id = ${auth.orgId}
      `;
      await sql`DELETE FROM campaign_steps WHERE campaign_id = ${id} AND org_id = ${auth.orgId}`;
    }
    for (const step of steps) {
      await sql`
        INSERT INTO campaign_steps (org_id, campaign_id, position, type, delay_days, mode, template, subject)
        VALUES (
          ${auth.orgId}, ${campaignId}, ${step.position}, ${step.type}, ${step.delayDays},
          ${step.mode}, ${step.template ?? null}, ${step.subject ?? null}
        )
      `;
    }
    revalidatePath("/campaigns");
    redirect(`/campaigns/${campaignId}`);
  }
  revalidatePath("/campaigns");
  redirect(`/campaigns/${id}`);
}

export async function activateCampaign(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) await fail("/campaigns", [auth.error]);
  if ("error" in auth) return;
  const id = text(form, "id");
  const { sql } = database();
  const rows = await sql<{ linkedin_seat_id: string | null; email_seat_id: string | null }[]>`
    SELECT linkedin_seat_id, email_seat_id FROM campaigns WHERE id = ${id} AND org_id = ${auth.orgId}
  `;
  const campaign = rows[0];
  if (!campaign) await fail("/campaigns", ["Campaign not found"]);
  const stepRows = await sql<{ position: number; type: StepDraft["type"]; delay_days: number; mode: "ai" | "fixed"; template: string | null; subject: string | null }[]>`
    SELECT position, type, delay_days, mode, template, subject
    FROM campaign_steps WHERE campaign_id = ${id} ORDER BY position
  `;
  const check = validateCampaign({
    linkedinSeatId: campaign.linkedin_seat_id,
    emailSeatId: campaign.email_seat_id,
    steps: stepRows.map((step) => ({
      position: step.position,
      type: step.type,
      delayDays: step.delay_days,
      mode: step.mode,
      template: step.template,
      subject: step.subject,
    })),
  }, "activate");
  if (!check.ok) await fail(`/campaigns/${id}`, check.errors);
  await sql`
    UPDATE campaigns SET active = true, updated_at = now()
    WHERE id = ${id} AND org_id = ${auth.orgId}
  `;
  await sql`
    INSERT INTO job_requests (org_id, type, payload, status)
    VALUES (${auth.orgId}, 'start_sequences', ${sql.json({ campaignId: id })}, 'pending')
  `;
  revalidatePath(`/campaigns/${id}`);
  redirect(`/campaigns/${id}`);
}

export async function deactivateCampaign(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) await fail("/campaigns", [auth.error]);
  if ("error" in auth) return;
  const id = text(form, "id");
  const { sql } = database();
  await sql`
    UPDATE campaigns SET active = false, updated_at = now()
    WHERE id = ${id} AND org_id = ${auth.orgId}
  `;
  await sql`
    DELETE FROM actions a
    USING contacts c
    WHERE a.contact_id = c.id
      AND c.campaign_id = ${id}
      AND c.org_id = ${auth.orgId}
      AND a.status = ANY(${DEACTIVATE_DELETE_STATUSES})
  `;
  revalidatePath(`/campaigns/${id}`);
  redirect(`/campaigns/${id}`);
}

export async function duplicateCampaign(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) await fail("/campaigns", [auth.error]);
  if ("error" in auth) return;
  const id = text(form, "id");
  const { sql } = database();
  const created = await sql<{ id: string }[]>`
    INSERT INTO campaigns (
      org_id, list_id, name, linkedin_seat_id, email_seat_id, goal, tone, language,
      review_messages, silent_visits, active, has_contacts
    )
    SELECT org_id, list_id, 'Copy of ' || name, linkedin_seat_id, email_seat_id, goal, tone, language,
           review_messages, silent_visits, false, false
    FROM campaigns WHERE id = ${id} AND org_id = ${auth.orgId}
    RETURNING id
  `;
  const copyId = created[0]?.id;
  if (!copyId) await fail("/campaigns", ["Campaign not found"]);
  await sql`
    INSERT INTO campaign_steps (org_id, campaign_id, position, type, delay_days, mode, template, subject)
    SELECT org_id, ${copyId}, position, type, delay_days, mode, template, subject
    FROM campaign_steps WHERE campaign_id = ${id} AND org_id = ${auth.orgId}
  `;
  revalidatePath("/campaigns");
  redirect(`/campaigns/${copyId}`);
}

export async function deleteCampaign(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) await fail("/campaigns", [auth.error]);
  if ("error" in auth) return;
  const id = text(form, "id");
  const { sql } = database();
  await sql`
    UPDATE contacts
    SET status = 'finished', finished_reason = 'campaign_deleted', next_step_at = NULL, updated_at = now()
    WHERE campaign_id = ${id} AND org_id = ${auth.orgId}
  `;
  await sql`DELETE FROM campaigns WHERE id = ${id} AND org_id = ${auth.orgId}`;
  revalidatePath("/campaigns");
  redirect("/campaigns");
}

export async function approveHeld(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) await fail("/campaigns", [auth.error]);
  if ("error" in auth) return;
  const id = text(form, "actionId");
  const campaignId = text(form, "campaignId");
  const next = approveAction("pending_approval");
  await database().sql`
    UPDATE actions SET status = ${next}, check_failed_reason = NULL, updated_at = now()
    WHERE id = ${id} AND org_id = ${auth.orgId} AND status = 'pending_approval'
  `;
  revalidatePath(`/campaigns/${campaignId}`);
  redirect(`/campaigns/${campaignId}?tab=held`);
}

export async function editHeld(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) await fail("/campaigns", [auth.error]);
  if ("error" in auth) return;
  const id = text(form, "actionId");
  const campaignId = text(form, "campaignId");
  await database().sql`
    UPDATE actions SET content = ${text(form, "content")}, subject = ${text(form, "subject") || null}, updated_at = now()
    WHERE id = ${id} AND org_id = ${auth.orgId} AND status = 'pending_approval'
  `;
  revalidatePath(`/campaigns/${campaignId}`);
  redirect(`/campaigns/${campaignId}?tab=held`);
}
