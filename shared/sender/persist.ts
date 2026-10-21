import { DateTime } from "luxon";
import type { Sql } from "postgres";
import type { ActionType } from "../config.js";
import { config } from "../config.js";
import { registerInviteLimitHit } from "../limits.js";
import type { UnipileClient } from "../providers/unipile.js";
import { seatLocalDate } from "../planner/quotas.js";
import type { StepRef } from "../sequence.js";
import { applyReconcile } from "./apply.js";
import { contactSnap, iso, stopOpenActions, writeContact, type ContactRow } from "./contact.js";
import { actionStatusAfter, executeSend, type SendAction, type SendOutcome, type SendVendor } from "./execute.js";
import { nextStatusForStuck, type VendorTrace } from "./reconcile.js";

/**
 * Send one claimed action and persist the outcome.
 * A row that is no longer `sending` is left untouched, so a retry cannot send twice.
 */
export async function runSendAction(sql: Sql, actionId: string, vendor: SendVendor, now = new Date()): Promise<SendOutcome | null> {
  const loaded = await loadSendAction(sql, actionId);
  if (!loaded) return null;
  const outcome = await executeSend(loaded.action, vendor, {
    nowIso: now.toISOString(),
    unsubscribeUrl: `${process.env.APP_URL ?? "http://localhost:3000"}/u/${loaded.action.contact.id}`,
  });
  await persistOutcome(sql, loaded, outcome, now);
  return outcome;
}

export async function runReconcile(
  sql: Sql,
  vendor: Pick<UnipileClient, "listInvitations" | "listChatMessages" | "listEmails">,
  now = new Date(),
): Promise<{ unknown: number; released: number; sent: number }> {
  const nowIso = now.toISOString();
  const unknownCutoff = new Date(now.getTime() - config.linkedin.unknownMinutes * 60_000);
  const overdueCutoff = new Date(now.getTime() - config.linkedin.overdueMinutes * 60_000);
  const markedUnknown = await sql<{ id: string }[]>`
    UPDATE actions SET status = 'unknown', updated_at = now()
    WHERE status = 'sending' AND claimed_at IS NOT NULL AND claimed_at <= ${unknownCutoff}
    RETURNING id
  `;
  const released = await sql<{ id: string }[]>`
    UPDATE actions SET status = 'ready', claimed_at = NULL, updated_at = now()
    WHERE status = 'planned' AND scheduled_for IS NOT NULL AND scheduled_for <= ${overdueCutoff}
    RETURNING id
  `;
  const stuck = await sql<StuckRow[]>`
    SELECT a.id, a.org_id, a.type, a.claimed_at, a.external_id, a.contact_id, a.linkedin_seat_id, a.email_seat_id,
           c.provider_id, c.linkedin_chat_id, c.network_distance,
           ls.unipile_account_id AS linkedin_account, es.unipile_account_id AS email_account
    FROM actions a
    JOIN contacts c ON c.id = a.contact_id
    LEFT JOIN linkedin_seats ls ON ls.id = a.linkedin_seat_id
    LEFT JOIN email_seats es ON es.id = a.email_seat_id
    WHERE a.status = 'unknown' AND a.claimed_at IS NOT NULL
  `;
  let sent = 0;
  const inviteCache = new Map<string, VendorTrace["invites"]>();
  for (const row of stuck) {
    const claimedAt = iso(row.claimed_at);
    if (!claimedAt) continue;
    const trace = await traceFor(vendor, row, claimedAt, inviteCache);
    const loaded = await loadSendAction(sql, row.id);
    if (!loaded) continue;
    const decision = applyReconcile({
      type: row.type,
      providerId: row.provider_id,
      trackingId: row.external_id ?? row.id,
      claimedAt,
      nowIso,
      contact: loaded.action.contact,
      steps: loaded.action.steps,
      networkDistance: row.network_distance,
      duplicateInOrg: loaded.action.duplicateProvider,
      vendor: trace,
    });
    if (decision.status === "sent") sent += 1;
    await sql`
      UPDATE actions SET
        status = ${decision.status},
        sent_at = CASE WHEN ${decision.status} = 'sent' THEN now() ELSE sent_at END,
        claimed_at = CASE WHEN ${decision.status} = 'ready' THEN NULL ELSE claimed_at END,
        error = CASE WHEN ${decision.status} = 'ready' THEN 'reconciled_missing' ELSE error END,
        updated_at = now()
      WHERE id = ${row.id} AND status = 'unknown'
    `;
    if (decision.status === "sent") await writeContact(sql, loaded.row, decision.contact);
  }
  return { unknown: markedUnknown.length, released: released.length, sent };
}

async function traceFor(
  vendor: Pick<UnipileClient, "listInvitations" | "listChatMessages" | "listEmails">,
  row: StuckRow,
  claimedAt: string,
  inviteCache: Map<string, VendorTrace["invites"]>,
): Promise<VendorTrace> {
  const trace: VendorTrace = { invites: [], messages: [], emails: [] };
  if (row.type === "invite" && row.linkedin_account) {
    const cached = inviteCache.get(row.linkedin_account);
    if (cached) trace.invites = cached;
    else {
      const invites = await vendor.listInvitations(row.linkedin_account);
      trace.invites = invites.map((invite) => ({ providerId: invite.providerId, at: invite.at }));
      inviteCache.set(row.linkedin_account, trace.invites);
    }
  }
  if (row.type === "message" && row.linkedin_account && row.linkedin_chat_id) {
    const messages = await vendor.listChatMessages(row.linkedin_account, row.linkedin_chat_id);
    trace.messages = messages
      .filter((message) => message.isSender)
      .map((message) => ({ providerId: row.provider_id ?? message.providerId ?? "", at: message.at }))
      .filter((message) => message.providerId);
  }
  if (row.type === "email" && row.email_account) {
    const mail = await vendor.listEmails(row.email_account, claimedAt);
    trace.emails = mail.map((item) => ({ trackingId: item.trackingId ?? item.id, at: item.at }));
  }
  return trace;
}

interface Loaded {
  action: SendAction;
  row: ContactRow;
  seatKind: "linkedin" | "email";
  seatId: string;
  zone: string;
}

async function loadSendAction(sql: Sql, actionId: string): Promise<Loaded | null> {
  const actions = await sql<JoinedAction[]>`
    SELECT a.id AS action_id, a.org_id, a.status, a.type, a.attempts, a.content, a.subject, a.claimed_at,
           a.scheduled_for, a.linkedin_seat_id, a.email_seat_id,
           camp.id AS campaign_id, camp.silent_visits, camp.review_messages,
           c.id AS contact_id, c.status AS contact_status, c.campaign_id AS contact_campaign_id,
           c.current_step, c.next_step_at, c.provider_id, c.accepted_at, c.invited_at, c.email,
           c.email_status, c.email_hidden_at, c.rejected_reason, c.finished_reason, c.network_distance,
           c.country, c.profile_url, c.name, c.first_name_clean, c.title, c.company, c.linkedin_chat_id,
           c.fit_score
    FROM actions a
    JOIN contacts c ON c.id = a.contact_id
    LEFT JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE a.id = ${actionId}
  `;
  const joined = actions[0];
  if (!joined) return null;
  const row = joinedContact(joined);
  const steps = joined.campaign_id
    ? await sql<{ position: number; type: StepRef["type"]; delayDays: number }[]>`
        SELECT position, type, delay_days AS "delayDays"
        FROM campaign_steps WHERE campaign_id = ${joined.campaign_id} ORDER BY position
      `
    : [];
  const seat = joined.linkedin_seat_id
    ? await sql<SeatJoin[]>`
        SELECT id, 'linkedin' AS kind, unipile_account_id, unipile_status, paused_reason, is_premium, timezone
        FROM linkedin_seats WHERE id = ${joined.linkedin_seat_id}
      `
    : await sql<SeatJoin[]>`
        SELECT id, 'email' AS kind, unipile_account_id, unipile_status, paused_reason, false AS is_premium, timezone
        FROM email_seats WHERE id = ${joined.email_seat_id}
      `;
  const seatRow = seat[0];
  if (!seatRow) return null;
  const suppressed = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM suppressions s
    WHERE (s.org_id = ${joined.org_id} OR s.org_id IS NULL)
      AND (
        (s.profile_url IS NOT NULL AND s.profile_url = ${joined.profile_url})
        OR (${joined.email}::text IS NOT NULL AND s.email IS NOT NULL AND lower(s.email) = lower(${joined.email}))
      )
  `;
  const duplicate = joined.provider_id
    ? await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM contacts
        WHERE org_id = ${joined.org_id} AND provider_id = ${joined.provider_id} AND id <> ${joined.contact_id}
      `
    : [{ n: 0 }];
  const replied = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM thread_messages m
    JOIN threads t ON t.id = m.thread_id
    WHERE t.contact_id = ${joined.contact_id} AND m.direction = 'in'
      AND m.sent_at > COALESCE((
        SELECT max(sent_at) FROM actions WHERE contact_id = ${row.id} AND status = 'sent'
      ), 'epoch')
  `;
  const contact = contactSnap(row);
  const action: SendAction = {
    id: joined.action_id,
    orgId: joined.org_id,
    status: joined.status,
    type: joined.type,
    attempts: joined.attempts,
    content: joined.content,
    subject: joined.subject,
    contact: { ...contact, profileUrl: row.profile_url, name: row.name, linkedinChatId: row.linkedin_chat_id },
    steps: steps.map((step) => ({ position: step.position, type: step.type, delayDays: step.delayDays })),
    seat: {
      id: seatRow.id,
      kind: seatRow.kind,
      unipileAccountId: seatRow.unipile_account_id,
      unipileStatus: seatRow.unipile_status,
      pausedReason: seatRow.paused_reason,
      isPremium: seatRow.is_premium,
      silentVisits: Boolean(joined.silent_visits),
    },
    suppressed: (suppressed[0]?.n ?? 0) > 0,
    duplicateProvider: (duplicate[0]?.n ?? 0) > 0,
    replied: (replied[0]?.n ?? 0) > 0,
  };
  return { action, row, seatKind: seatRow.kind, seatId: seatRow.id, zone: seatRow.timezone || "UTC" };
}

async function persistOutcome(sql: Sql, loaded: Loaded, outcome: SendOutcome, now: Date): Promise<void> {
  const status = actionStatusAfter(outcome);
  if (outcome.kind === "stopped" || !status) return;
  const attempts = outcome.kind === "failure" && outcome.failure.kind === "temporary" ? outcome.failure.attempts : loaded.action.attempts;
  const error = outcome.kind === "failure"
    ? outcome.failure.kind
    : outcome.kind === "deferred" || outcome.kind === "skipped"
      ? outcome.reason
      : null;
  const externalId = outcome.kind === "sent" ? outcome.externalId : null;
  await sql`
    UPDATE actions SET
      status = ${status},
      attempts = ${attempts},
      error = ${error},
      external_id = COALESCE(${externalId}, external_id),
      sent_at = CASE WHEN ${status} = 'sent' THEN ${now} ELSE sent_at END,
      claimed_at = CASE WHEN ${status} = 'ready' THEN NULL ELSE claimed_at END,
      updated_at = now()
    WHERE id = ${loaded.action.id}
  `;
  if (outcome.kind === "sent" || outcome.kind === "skipped" || outcome.kind === "failure") {
    const firstName = outcome.kind === "sent" ? outcome.firstNameClean : null;
    const chatId = outcome.kind === "sent" ? outcome.chatId : null;
    await writeContact(sql, loaded.row, outcome.contact, { firstNameClean: firstName, chatId });
  }
  const contact = outcome.kind === "sent" || outcome.kind === "skipped" || outcome.kind === "failure" ? outcome.contact : null;
  const stop = (outcome.kind === "skipped" && (outcome.reason === "replied" || outcome.reason === "suppressed"))
    || contact?.status === "replied"
    || contact?.finishedReason === "duplicate";
  if (stop) await stopOpenActions(sql, loaded.action.contact.id, loaded.action.id);
  for (const call of outcome.calls) {
    await sql`
      INSERT INTO provider_calls (org_id, seat_id, seat_type, route, status_code, error_type)
      VALUES (${loaded.action.orgId}, ${loaded.seatId}, ${loaded.seatKind}, ${call.route}, ${call.statusCode}, ${call.errorType})
    `;
  }
  if (outcome.kind === "sent" && (loaded.action.type === "message" || loaded.action.type === "email") && loaded.action.content) {
    await recordOutbound(sql, loaded, outcome.chatId, now);
  }
  if (outcome.kind === "failure" && outcome.failure.kind === "limit") {
    const day = seatLocalDate(loaded.zone, DateTime.fromJSDate(now, { zone: "utc" }));
    await sql`
      INSERT INTO seat_quota_blocks (org_id, seat_id, seat_kind, action_type, block_date)
      VALUES (${loaded.action.orgId}, ${loaded.seatId}, ${loaded.seatKind}, ${loaded.action.type}, ${day})
      ON CONFLICT (seat_id, action_type, block_date) DO NOTHING
    `;
    if (loaded.action.type === "invite" && loaded.seatKind === "linkedin") {
      await noteInviteLimit(sql, loaded.seatId, loaded.zone, now);
    }
  }
  if (outcome.kind === "failure" && outcome.failure.kind === "account") {
    if (loaded.seatKind === "linkedin") {
      await sql`UPDATE linkedin_seats SET paused_reason = 'account', updated_at = now() WHERE id = ${loaded.seatId}`;
    } else {
      await sql`UPDATE email_seats SET paused_reason = 'account', updated_at = now() WHERE id = ${loaded.seatId}`;
    }
  }
}

async function noteInviteLimit(sql: Sql, seatId: string, zone: string, now: Date): Promise<void> {
  const rows = await sql<{ invite_limit_streak: number; last_invite_limit_on: string | null }[]>`
    SELECT invite_limit_streak, last_invite_limit_on::text AS last_invite_limit_on
    FROM linkedin_seats WHERE id = ${seatId}
  `;
  const row = rows[0];
  if (!row) return;
  const today = seatLocalDate(zone, DateTime.fromJSDate(now, { zone: "utc" }));
  const result = registerInviteLimitHit(
    { streak: row.invite_limit_streak, lastOn: row.last_invite_limit_on },
    today,
    DateTime.fromJSDate(now, { zone }),
  );
  await sql`
    UPDATE linkedin_seats SET
      invite_limit_streak = ${result.streak},
      last_invite_limit_on = ${result.lastOn},
      invites_paused_until = COALESCE(${result.pauseUntil}, invites_paused_until),
      weekly_cap_factor = COALESCE(${result.nextFactor}, weekly_cap_factor),
      weekly_cap_cut_until = COALESCE(${result.cutUntil}, weekly_cap_cut_until),
      updated_at = now()
    WHERE id = ${seatId}
  `;
}

async function recordOutbound(sql: Sql, loaded: Loaded, chatId: string | null, now: Date): Promise<void> {
  const channel = loaded.action.type === "email" ? "email" : "linkedin";
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM threads
    WHERE org_id = ${loaded.action.orgId} AND contact_id = ${loaded.action.contact.id} AND channel = ${channel}
    LIMIT 1
  `;
  let threadId = existing[0]?.id;
  if (!threadId) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO threads (org_id, contact_id, channel, external_id, last_message_at)
      VALUES (${loaded.action.orgId}, ${loaded.action.contact.id}, ${channel}, ${chatId}, ${now})
      RETURNING id
    `;
    threadId = inserted[0]?.id;
  } else {
    await sql`UPDATE threads SET last_message_at = ${now}, external_id = COALESCE(external_id, ${chatId}), updated_at = now() WHERE id = ${threadId}`;
  }
  if (!threadId) return;
  await sql`
    INSERT INTO thread_messages (org_id, thread_id, external_id, direction, content, sent_at)
    VALUES (${loaded.action.orgId}, ${threadId}, ${loaded.action.id}, 'out', ${loaded.action.content}, ${now})
  `;
}

export function stuckStatus(row: { status: string; claimedAt: string | null; scheduledFor: string | null }, nowIso: string): "unknown" | "ready" | null {
  return nextStatusForStuck({ ...row, nowIso });
}

function joinedContact(joined: JoinedAction): ContactRow {
  return {
    id: joined.contact_id,
    org_id: joined.org_id,
    status: joined.contact_status,
    campaign_id: joined.contact_campaign_id,
    current_step: joined.current_step,
    next_step_at: joined.next_step_at,
    provider_id: joined.provider_id,
    accepted_at: joined.accepted_at,
    invited_at: joined.invited_at,
    email: joined.email,
    email_status: joined.email_status,
    rejected_reason: joined.rejected_reason,
    finished_reason: joined.finished_reason,
    network_distance: joined.network_distance,
    country: joined.country,
    profile_url: joined.profile_url,
    name: joined.name,
    first_name_clean: joined.first_name_clean,
    title: joined.title,
    company: joined.company,
    linkedin_chat_id: joined.linkedin_chat_id,
    fit_score: joined.fit_score,
    email_hidden_at: joined.email_hidden_at,
  };
}

interface JoinedAction {
  action_id: string;
  org_id: string;
  status: string;
  type: ActionType;
  attempts: number;
  content: string | null;
  subject: string | null;
  claimed_at: Date | string | null;
  scheduled_for: Date | string | null;
  linkedin_seat_id: string | null;
  email_seat_id: string | null;
  campaign_id: string | null;
  silent_visits: boolean | null;
  review_messages: boolean | null;
  contact_id: string;
  contact_status: string;
  contact_campaign_id: string | null;
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

interface SeatJoin {
  id: string;
  kind: "linkedin" | "email";
  unipile_account_id: string;
  unipile_status: string;
  paused_reason: string | null;
  is_premium: boolean;
  timezone: string;
}

interface StuckRow {
  id: string;
  org_id: string;
  type: ActionType;
  claimed_at: Date | string | null;
  external_id: string | null;
  contact_id: string;
  linkedin_seat_id: string | null;
  email_seat_id: string | null;
  provider_id: string | null;
  linkedin_chat_id: string | null;
  network_distance: string | null;
  linkedin_account: string | null;
  email_account: string | null;
}
