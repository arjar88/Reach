"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { config } from "../../../../shared/config.js";
import { validateSeatLimits } from "../../../../shared/limits.js";
import { createUnipile } from "../../../../shared/providers/unipile.js";
import { database } from "../db.js";
import { currentOrg } from "../session.js";

function num(form: FormData, key: string): number | undefined {
  const raw = form.get(key);
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return Number(raw);
}

function days(form: FormData): number[] {
  return form.getAll("activeDays").map((value) => Number(value)).filter((value) => value >= 1 && value <= 7);
}

function clock(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  return value;
}

export async function updateSeatSettings(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) redirect(`/accounts?error=${encodeURIComponent(auth.error)}`);
  const seatId = String(form.get("seatId") ?? "");
  const kind = String(form.get("kind") ?? "");
  const errors = validateSeatLimits({
    dailyInvites: num(form, "dailyInvites"),
    weeklyInvites: num(form, "weeklyInvites"),
    dailyMessages: num(form, "dailyMessages"),
    dailyViews: num(form, "dailyViews"),
    dailyActions: num(form, "dailyActions"),
    dailyEmail: num(form, "dailyEmail"),
  });
  const start = clock(form.get("launchStart"));
  const end = clock(form.get("launchEnd"));
  if (!start || !end) errors.push("Hours must be HH:MM");
  const activeDays = days(form);
  if (activeDays.length === 0) errors.push("Pick at least one active day");
  const zone = String(form.get("timezone") ?? "UTC");
  if (errors.length || !start || !end) {
    redirect(`/accounts?error=${encodeURIComponent(errors.join(". "))}`);
  }
  const { sql } = database();
  if (kind === "email") {
    await sql`
      UPDATE email_seats SET
        daily_limit = ${num(form, "dailyEmail") ?? config.email.dailyLimit},
        launch_start = ${start},
        launch_end = ${end},
        active_days = ${activeDays},
        timezone = ${zone},
        updated_at = now()
      WHERE id = ${seatId} AND org_id = ${auth.orgId}
    `;
  } else {
    await sql`
      UPDATE linkedin_seats SET
        daily_invites = ${num(form, "dailyInvites") ?? config.linkedin.dailyInvites},
        weekly_invites = ${num(form, "weeklyInvites") ?? config.linkedin.weeklyInvites},
        daily_messages = ${num(form, "dailyMessages") ?? config.linkedin.dailyMessages},
        daily_views = ${num(form, "dailyViews") ?? config.linkedin.dailyViews},
        daily_actions = ${num(form, "dailyActions") ?? config.linkedin.dailyActions},
        launch_start = ${start},
        launch_end = ${end},
        active_days = ${activeDays},
        timezone = ${zone},
        updated_at = now()
      WHERE id = ${seatId} AND org_id = ${auth.orgId}
    `;
  }
  revalidatePath("/accounts");
  redirect("/accounts");
}

export async function removeSeat(form: FormData): Promise<void> {
  const auth = await currentOrg();
  if ("error" in auth) redirect(`/accounts?error=${encodeURIComponent(auth.error)}`);
  const seatId = String(form.get("seatId") ?? "");
  const kind = String(form.get("kind") ?? "linkedin");
  const { sql } = database();
  const rows = kind === "email"
    ? await sql<{ unipile_account_id: string }[]>`
        SELECT unipile_account_id FROM email_seats WHERE id = ${seatId} AND org_id = ${auth.orgId}
      `
    : await sql<{ unipile_account_id: string }[]>`
        SELECT unipile_account_id FROM linkedin_seats WHERE id = ${seatId} AND org_id = ${auth.orgId}
      `;
  const accountId = rows[0]?.unipile_account_id;
  if (!accountId) redirect("/accounts?error=Seat%20not%20found");
  await sql`
    UPDATE campaigns SET active = false, updated_at = now()
    WHERE org_id = ${auth.orgId}
      AND ((${kind} = 'email' AND email_seat_id = ${seatId}) OR (${kind} <> 'email' AND linkedin_seat_id = ${seatId}))
  `;
  try {
    await createUnipile().deleteAccount(accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unipile delete failed";
    redirect(`/accounts?error=${encodeURIComponent(`Seat kept. ${message}`)}`);
  }
  await sql.begin(async (tx) => {
    if (kind === "email") {
      await tx`DELETE FROM actions WHERE email_seat_id = ${seatId} AND org_id = ${auth.orgId}`;
      await tx`DELETE FROM email_seats WHERE id = ${seatId} AND org_id = ${auth.orgId}`;
    } else {
      await tx`DELETE FROM actions WHERE linkedin_seat_id = ${seatId} AND org_id = ${auth.orgId}`;
      await tx`DELETE FROM linkedin_seats WHERE id = ${seatId} AND org_id = ${auth.orgId}`;
    }
  });
  revalidatePath("/accounts");
  redirect("/accounts");
}
