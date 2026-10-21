import { DateTime } from "luxon";
import type { Sql } from "postgres";
import type { ActionType } from "../config.js";
import { config } from "../config.js";
import { defaultActiveDays, emptyUsage, localDayBounds, type UsageCounts } from "../limits.js";
import { createModel } from "../providers/model.js";
import type { UnipileClient } from "../providers/unipile.js";
import { writePrompt } from "../prompts/index.js";
import { writeSchema } from "../prompts/schemas.js";
import { onInviteTimeout, onStepFailed, type StepRef } from "../sequence.js";
import { contactSnap, writeContact, type ContactRow } from "../sender/contact.js";
import { planSeat, type DueContact, type ReadyItem } from "./plan.js";
import { emailQuotaRemaining, linkedinQuotaRemaining, seatLocalDate } from "./quotas.js";

export interface PlanTarget {
  id: string;
  kind: "linkedin" | "email";
}

const CONTACT_COLUMNS = `
  c.id, c.org_id, c.status, c.campaign_id, c.current_step, c.next_step_at, c.provider_id,
  c.accepted_at, c.invited_at, c.email, c.email_status, c.email_hidden_at, c.rejected_reason,
  c.finished_reason, c.network_distance, c.country, c.profile_url, c.name, c.first_name_clean,
  c.title, c.company, c.linkedin_chat_id, c.fit_score
`;

export async function listPlannableSeats(sql: Sql): Promise<PlanTarget[]> {
  const linkedin = await sql<{ id: string }[]>`SELECT id FROM linkedin_seats`;
  const email = await sql<{ id: string }[]>`SELECT id FROM email_seats`;
  return [
    ...linkedin.map((row) => ({ id: row.id, kind: "linkedin" as const })),
    ...email.map((row) => ({ id: row.id, kind: "email" as const })),
  ];
}

export async function runPlanSeat(
  sql: Sql,
  seatId: string,
  kind: "linkedin" | "email",
  vendor: Pick<UnipileClient, "listInvitations">,
  now = new Date(),
): Promise<void> {
  if (kind === "linkedin") await runLinkedin(sql, seatId, vendor, now);
  else await runEmail(sql, seatId, now);
}

async function runLinkedin(
  sql: Sql,
  seatId: string,
  vendor: Pick<UnipileClient, "listInvitations">,
  now: Date,
): Promise<void> {
  const seats = await sql<LinkedinSeat[]>`
    SELECT id, org_id, unipile_account_id, unipile_status, paused_reason, timezone, country,
           is_premium, connected_at, connections_count, daily_invites, weekly_invites,
           daily_messages, daily_views, daily_actions, launch_start, launch_end, active_days,
           invites_paused_until, weekly_cap_factor, weekly_cap_cut_until
    FROM linkedin_seats WHERE id = ${seatId}
  `;
  const seat = seats[0];
  if (!seat) return;
  const zone = seat.timezone || "UTC";
  const instant = DateTime.fromJSDate(now, { zone: "utc" });
  if (seat.unipile_status === "OK") {
    await scheduleWithdrawals(sql, seat, vendor, instant).catch(() => {
      /* A vendor miss leaves existing withdraw rows alone. Planning still runs. */
    });
  }
  const bounds = localDayBounds(zone, instant);
  const weekStart = instant.setZone(zone).startOf("week");
  const usageRows = await sql<{ type: ActionType; status: string; n: number }[]>`
    SELECT type, status, count(*)::int AS n
    FROM actions
    WHERE linkedin_seat_id = ${seat.id}
      AND status IN ('sent', 'planned', 'sending', 'unknown')
      AND coalesce(sent_at, scheduled_for, created_at) >= ${bounds.start.toJSDate()}
      AND coalesce(sent_at, scheduled_for, created_at) < ${bounds.end.toJSDate()}
    GROUP BY type, status
  `;
  const usage: Partial<Record<ActionType, UsageCounts>> = {};
  const total = emptyUsage();
  for (const row of usageRows) {
    const bucket = usage[row.type] ?? emptyUsage();
    addStatus(bucket, row.status, row.n);
    addStatus(total, row.status, row.n);
    usage[row.type] = bucket;
  }
  const blocks = await sql<{ action_type: ActionType }[]>`
    SELECT action_type FROM seat_quota_blocks
    WHERE seat_id = ${seat.id} AND block_date = ${seatLocalDate(zone, instant)}
  `;
  const blocked: Partial<Record<ActionType, boolean>> = {};
  for (const row of blocks) blocked[row.action_type] = true;
  const weekly = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM actions
    WHERE linkedin_seat_id = ${seat.id}
      AND type = 'invite'
      AND status IN ('sent', 'planned', 'sending', 'unknown')
      AND coalesce(sent_at, scheduled_for, created_at) >= ${weekStart.toJSDate()}
  `;
  const sample = await sql<{ sent_invites: number; accepted: number }[]>`
    SELECT
      count(*) FILTER (WHERE a.type = 'invite' AND a.status = 'sent')::int AS sent_invites,
      count(*) FILTER (WHERE a.type = 'invite' AND a.status = 'sent' AND c.accepted_at IS NOT NULL)::int AS accepted
    FROM actions a
    JOIN contacts c ON c.id = a.contact_id
    WHERE a.linkedin_seat_id = ${seat.id}
  `;
  const remaining = linkedinQuotaRemaining({
    seat: {
      dailyInvites: seat.daily_invites,
      weeklyInvites: seat.weekly_invites,
      dailyMessages: seat.daily_messages,
      dailyViews: seat.daily_views,
      dailyActions: seat.daily_actions,
      dailyEmail: 0,
      connections: seat.connections_count,
      connectedAt: seat.connected_at,
      pausedUntil: seat.invites_paused_until,
      weeklyFactor: seat.weekly_cap_factor,
      weeklyCutUntil: seat.weekly_cap_cut_until,
      invitesSentSample: sample[0]?.sent_invites ?? 0,
      invitesAcceptedSample: sample[0]?.accepted ?? 0,
      weeklyInvitesSent: weekly[0]?.n ?? 0,
    },
    usage,
    totalUsage: total,
    blocked,
    now,
  });
  const ready = await readyItems(sql, "linkedin", seat.id);
  const due = await dueContacts(sql, "linkedin", seat.id, now);
  const result = await planSeat({
    now: instant,
    zone,
    startHH: seat.launch_start,
    endHH: seat.launch_end,
    activeDays: seat.active_days?.length ? seat.active_days : defaultActiveDays(seat.country),
    remaining,
    ready,
    due,
    write: (item) => writeCopy(item),
  });
  await persistPlan(sql, seat.org_id, seat.id, null, result);
}

async function runEmail(sql: Sql, seatId: string, now: Date): Promise<void> {
  const seats = await sql<EmailSeat[]>`
    SELECT id, org_id, timezone, daily_limit, launch_start, launch_end, active_days
    FROM email_seats WHERE id = ${seatId}
  `;
  const seat = seats[0];
  if (!seat) return;
  const zone = seat.timezone || "UTC";
  const instant = DateTime.fromJSDate(now, { zone: "utc" });
  const bounds = localDayBounds(zone, instant);
  const usageRows = await sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n FROM actions
    WHERE email_seat_id = ${seat.id}
      AND type = 'email'
      AND status IN ('sent', 'planned', 'sending', 'unknown')
      AND coalesce(sent_at, scheduled_for, created_at) >= ${bounds.start.toJSDate()}
      AND coalesce(sent_at, scheduled_for, created_at) < ${bounds.end.toJSDate()}
    GROUP BY status
  `;
  const usage = emptyUsage();
  for (const row of usageRows) addStatus(usage, row.status, row.n);
  const blocks = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM seat_quota_blocks
    WHERE seat_id = ${seat.id} AND action_type = 'email' AND block_date = ${seatLocalDate(zone, instant)}
  `;
  const left = emailQuotaRemaining(seat.daily_limit, usage, (blocks[0]?.n ?? 0) > 0);
  const ready = await readyItems(sql, "email", seat.id);
  const due = await dueContacts(sql, "email", seat.id, now);
  const result = await planSeat({
    now: instant,
    zone,
    startHH: seat.launch_start,
    endHH: seat.launch_end,
    remaining: { visit: 0, invite: 0, message: 0, email: left, withdraw: 0, total: left },
    ready,
    due,
    write: (item) => writeCopy(item),
    activeDays: seat.active_days?.length ? seat.active_days : defaultActiveDays(null),
  });
  await persistPlan(sql, seat.org_id, null, seat.id, result);
}

async function scheduleWithdrawals(
  sql: Sql,
  seat: LinkedinSeat,
  vendor: Pick<UnipileClient, "listInvitations">,
  now: DateTime,
): Promise<void> {
  const cutoff = now.minus({ days: config.linkedin.inviteTimeoutDays }).toJSDate();
  const rows = await sql<ContactRow[]>`
    SELECT ${sql.unsafe(CONTACT_COLUMNS)}
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id AND camp.linkedin_seat_id = ${seat.id} AND camp.active
    WHERE c.status = 'awaiting_acceptance'
      AND c.invited_at IS NOT NULL
      AND c.invited_at <= ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM actions a
        WHERE a.contact_id = c.id AND a.type = 'withdraw'
          AND a.status IN ('pending_approval', 'ready', 'planned', 'sending', 'unknown', 'sent')
      )
  `;
  if (rows.length === 0) return;
  const invites = await vendor.listInvitations(seat.unipile_account_id);
  const pending = new Set(invites.map((invite) => invite.providerId));
  const nowIso = now.toUTC().toISO()!;
  for (const row of rows) {
    const steps = await stepsFor(sql, row.campaign_id);
    const snap = contactSnap(row);
    const stillPending = Boolean(row.provider_id && pending.has(row.provider_id));
    const transition = onInviteTimeout({
      contact: snap,
      steps,
      nowIso,
      pending: stillPending,
      connected: !stillPending,
    });
    await writeContact(sql, row, transition.contact);
    if (transition.effects.some((effect) => effect.type === "schedule_withdraw")) {
      await sql`
        INSERT INTO actions (
          org_id, contact_id, source, type, linkedin_seat_id, status, scheduled_for
        ) VALUES (
          ${seat.org_id}, ${row.id}, 'sequence', 'withdraw', ${seat.id}, 'ready', ${now.toJSDate()}
        )
      `;
    }
  }
}

async function readyItems(sql: Sql, kind: "linkedin" | "email", seatId: string): Promise<ReadyItem[]> {
  const rows = kind === "linkedin"
    ? await sql<ReadyRow[]>`
        SELECT id, contact_id, type, created_at, content, subject
        FROM actions WHERE linkedin_seat_id = ${seatId} AND status = 'ready'
      `
    : await sql<ReadyRow[]>`
        SELECT id, contact_id, type, created_at, content, subject
        FROM actions WHERE email_seat_id = ${seatId} AND status = 'ready'
      `;
  return rows.map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    type: row.type,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    content: row.content,
    subject: row.subject,
  }));
}

async function dueContacts(sql: Sql, kind: "linkedin" | "email", seatId: string, now: Date): Promise<DueContact[]> {
  const seatColumn = kind === "linkedin" ? "camp.linkedin_seat_id" : "camp.email_seat_id";
  const rows = await sql<DueRow[]>`
    SELECT ${sql.unsafe(CONTACT_COLUMNS)},
           s.id AS step_id, s.position, s.type AS step_type, s.delay_days, s.mode, s.template, s.subject AS step_subject,
           camp.id AS camp_id, camp.review_messages, camp.language,
           EXISTS (
             SELECT 1 FROM actions o
             WHERE o.contact_id = c.id
               AND o.status IN ('pending_approval', 'ready', 'planned', 'sending', 'unknown')
           ) AS has_open
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id AND camp.active AND ${sql.unsafe(seatColumn)} = ${seatId}
    JOIN campaign_steps s ON s.campaign_id = camp.id AND s.position = c.current_step
    WHERE c.status = 'in_campaign' AND c.next_step_at IS NOT NULL AND c.next_step_at <= ${now}
  `;
  return rows.map((row) => ({
    contact: contactSnap(row),
    step: {
      id: row.step_id,
      position: row.position,
      type: row.step_type,
      delayDays: row.delay_days,
      mode: row.mode === "fixed" ? "fixed" : "ai",
      template: row.template,
      subject: row.step_subject,
    },
    campaignId: row.camp_id,
    fitScore: row.fit_score ?? 0,
    reviewMessages: row.review_messages,
    language: row.language,
    firstName: row.first_name_clean ?? row.name,
    company: row.company,
    title: row.title,
    hasOpenAction: row.has_open,
  }));
}

async function persistPlan(
  sql: Sql,
  orgId: string,
  linkedinSeatId: string | null,
  emailSeatId: string | null,
  result: Awaited<ReturnType<typeof planSeat>>,
): Promise<void> {
  for (const item of result.planned) {
    if (item.actionId) {
      await sql`
        UPDATE actions
        SET status = 'planned', scheduled_for = ${item.scheduledFor},
            content = COALESCE(${item.content}, content),
            subject = COALESCE(${item.subject}, subject),
            updated_at = now()
        WHERE id = ${item.actionId} AND status = 'ready'
      `;
      continue;
    }
    await sql`
      INSERT INTO actions (
        org_id, contact_id, campaign_step_id, source, type,
        linkedin_seat_id, email_seat_id, content, subject, scheduled_for, status
      ) VALUES (
        ${orgId}, ${item.contactId}, ${item.stepId}, 'sequence', ${item.type},
        ${linkedinSeatId}, ${emailSeatId}, ${item.content}, ${item.subject}, ${item.scheduledFor}, 'planned'
      )
      ON CONFLICT (contact_id, campaign_step_id) WHERE campaign_step_id IS NOT NULL DO NOTHING
    `;
  }
  for (const held of result.held) {
    await sql`
      INSERT INTO actions (
        org_id, contact_id, campaign_step_id, source, type,
        linkedin_seat_id, email_seat_id, content, subject, check_failed_reason, status
      ) VALUES (
        ${orgId}, ${held.contactId}, ${held.stepId}, 'sequence', ${held.type},
        ${linkedinSeatId}, ${emailSeatId}, ${held.content}, ${held.subject}, ${held.reason}, 'pending_approval'
      )
      ON CONFLICT (contact_id, campaign_step_id) WHERE campaign_step_id IS NOT NULL DO NOTHING
    `;
  }
  for (const contactId of result.enrich) {
    await sql`
      UPDATE contacts
      SET enrichment_requested_at = COALESCE(enrichment_requested_at, now()), updated_at = now()
      WHERE id = ${contactId}
    `;
  }
  for (const advance of result.advances) {
    const rows = await sql<ContactRow[]>`
      SELECT ${sql.unsafe(CONTACT_COLUMNS)} FROM contacts c WHERE c.id = ${advance.contactId}
    `;
    const row = rows[0];
    if (!row) continue;
    const steps = await stepsFor(sql, row.campaign_id);
    const transition = onStepFailed(contactSnap(row), steps, new Date().toISOString());
    await writeContact(sql, row, {
      ...transition.contact,
      finishedReason: transition.contact.finishedReason ?? advance.reason,
    });
  }
}

async function stepsFor(sql: Sql, campaignId: string | null): Promise<StepRef[]> {
  if (!campaignId) return [];
  const rows = await sql<{ position: number; type: StepRef["type"]; delay_days: number }[]>`
    SELECT position, type, delay_days FROM campaign_steps
    WHERE campaign_id = ${campaignId}
    ORDER BY position
  `;
  return rows.map((row) => ({ position: row.position, type: row.type, delayDays: row.delay_days }));
}

async function writeCopy(due: DueContact): Promise<{ subject?: string; body: string }> {
  const model = createModel();
  const prompt = writePrompt({
    language: due.language,
    step: due.step.type,
    template: due.step.template,
    firstName: due.firstName,
    company: due.company,
    title: due.title,
  });
  return model.json("small", prompt.system, prompt.user, writeSchema);
}

function addStatus(bucket: UsageCounts, status: string, n: number): void {
  if (status === "sent") bucket.sent += n;
  else if (status === "planned") bucket.planned += n;
  else if (status === "sending") bucket.sending += n;
  else if (status === "unknown") bucket.unknown += n;
}

interface LinkedinSeat {
  id: string;
  org_id: string;
  unipile_account_id: string;
  unipile_status: string;
  paused_reason: string | null;
  timezone: string;
  country: string | null;
  is_premium: boolean;
  connected_at: Date | null;
  connections_count: number;
  daily_invites: number;
  weekly_invites: number;
  daily_messages: number;
  daily_views: number;
  daily_actions: number;
  launch_start: string;
  launch_end: string;
  active_days: number[] | null;
  invites_paused_until: Date | null;
  weekly_cap_factor: number;
  weekly_cap_cut_until: Date | null;
}

interface EmailSeat {
  id: string;
  org_id: string;
  timezone: string;
  daily_limit: number;
  launch_start: string;
  launch_end: string;
  active_days: number[] | null;
}

interface ReadyRow {
  id: string;
  contact_id: string;
  type: ActionType;
  created_at: Date | string;
  content: string | null;
  subject: string | null;
}

interface DueRow extends ContactRow {
  step_id: string;
  position: number;
  step_type: DueContact["step"]["type"];
  delay_days: number;
  mode: string;
  template: string | null;
  step_subject: string | null;
  camp_id: string;
  review_messages: boolean;
  language: string;
  has_open: boolean;
}
