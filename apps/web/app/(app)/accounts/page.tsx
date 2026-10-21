import { config } from "../../../../../shared/config.js";
import { rampDailyCap } from "../../../../../shared/limits.js";
import { removeSeat, updateSeatSettings } from "../../../lib/actions/accounts.js";
import { database } from "../../../lib/db.js";
import { currentOrg } from "../../../lib/session.js";

const DAYS = [
  ["1", "Mon"],
  ["2", "Tue"],
  ["3", "Wed"],
  ["4", "Thu"],
  ["5", "Fri"],
  ["6", "Sat"],
  ["7", "Sun"],
] as const;

export const dynamic = "force-dynamic";

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const params = await searchParams;
  const auth = await currentOrg();
  if ("error" in auth) {
    return (
      <main>
        <h1>Accounts</h1>
        <p className="banner">{auth.error}</p>
      </main>
    );
  }
  const { sql } = database();
  const linkedin = await sql<LinkedinSeat[]>`
    SELECT id, unipile_status, paused_reason, timezone, is_premium, connected_at, connections_count,
           daily_invites, weekly_invites, daily_messages, daily_views, daily_actions,
           launch_start, launch_end, active_days
    FROM linkedin_seats WHERE org_id = ${auth.orgId} ORDER BY created_at
  `;
  const email = await sql<EmailSeat[]>`
    SELECT id, address, unipile_status, paused_reason, timezone, daily_limit, launch_start, launch_end, active_days
    FROM email_seats WHERE org_id = ${auth.orgId} ORDER BY created_at
  `;
  return (
    <main>
      <h1>Accounts</h1>
      <p className="lede">Connect a seat, then set hours and caps. Caps cannot rise above the product ceilings. Connecting does not start a campaign.</p>
      {params.error ? <p className="banner">{params.error}</p> : null}
      {params.connected ? <p className="banner">Account saved. Campaigns stay inactive until you activate one.</p> : null}
      <div className="row">
        <form action="/api/unipile/connect-link" method="post"><input type="hidden" name="provider" value="LINKEDIN" /><button type="submit">Connect LinkedIn</button></form>
        <form action="/api/unipile/connect-link" method="post"><input type="hidden" name="provider" value="GOOGLE" /><button className="ghost" type="submit">Connect Gmail</button></form>
        <form action="/api/unipile/connect-link" method="post"><input type="hidden" name="provider" value="OUTLOOK" /><button className="ghost" type="submit">Connect Outlook</button></form>
      </div>
      <div className="cards" style={{ marginTop: 20 }}>
        {linkedin.map((seat) => {
          const cap = rampDailyCap({
            connectedAt: seat.connected_at ?? new Date(),
            now: new Date(),
            connections: seat.connections_count,
            fullCap: Math.min(seat.daily_invites, config.linkedin.dailyInvites),
          });
          return (
            <article className="card" key={seat.id}>
              <h2>LinkedIn {seat.is_premium ? "· Premium" : ""}</h2>
              <p className={seat.unipile_status === "OK" && !seat.paused_reason ? "status-ok" : "status-bad"}>
                {seat.unipile_status}{seat.paused_reason ? ` · paused (${seat.paused_reason})` : ""}
              </p>
              <p className="meta">{seat.connections_count} connections. Invite ramp today: {seat.connected_at ? cap : "starts when connected"} (ceiling {config.linkedin.dailyInvites}/day, {config.linkedin.weeklyInvites}/week).</p>
              <form action={updateSeatSettings}>
                <input type="hidden" name="seatId" value={seat.id} />
                <input type="hidden" name="kind" value="linkedin" />
                <SeatHours start={seat.launch_start} end={seat.launch_end} zone={seat.timezone} days={seat.active_days} />
                <div className="limits">
                  <Field name="dailyInvites" label={`Invites / day (max ${config.linkedin.dailyInvites})`} value={seat.daily_invites} />
                  <Field name="weeklyInvites" label={`Invites / week (max ${config.linkedin.weeklyInvites})`} value={seat.weekly_invites} />
                  <Field name="dailyMessages" label={`Messages / day (max ${config.linkedin.dailyMessages})`} value={seat.daily_messages} />
                  <Field name="dailyViews" label={`Visits / day (max ${config.linkedin.dailyViews})`} value={seat.daily_views} />
                  <Field name="dailyActions" label={`Actions / day (max ${config.linkedin.dailyActions})`} value={seat.daily_actions} />
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <button type="submit">Save limits</button>
                </div>
              </form>
              <form action="/api/unipile/connect-link" method="post" style={{ marginTop: 8 }}>
                <input type="hidden" name="provider" value="LINKEDIN" />
                <input type="hidden" name="seatId" value={seat.id} />
                <button className="ghost" type="submit">Reconnect</button>
              </form>
              <form action={removeSeat} style={{ marginTop: 8 }}>
                <input type="hidden" name="seatId" value={seat.id} />
                <input type="hidden" name="kind" value="linkedin" />
                <button className="warn" type="submit">Remove seat</button>
              </form>
            </article>
          );
        })}
        {email.map((seat) => (
          <article className="card" key={seat.id}>
            <h2>Email</h2>
            <p className={seat.unipile_status === "OK" && !seat.paused_reason ? "status-ok" : "status-bad"}>
              {seat.unipile_status}{seat.paused_reason ? ` · paused (${seat.paused_reason})` : ""}
            </p>
            <p className="meta">{seat.address}</p>
            <form action={updateSeatSettings}>
              <input type="hidden" name="seatId" value={seat.id} />
              <input type="hidden" name="kind" value="email" />
              <SeatHours start={seat.launch_start} end={seat.launch_end} zone={seat.timezone} days={seat.active_days} />
              <Field name="dailyEmail" label={`Emails / day (max ${config.email.dailyLimit})`} value={seat.daily_limit} />
              <div className="row" style={{ marginTop: 12 }}><button type="submit">Save limits</button></div>
            </form>
            <form action="/api/unipile/connect-link" method="post" style={{ marginTop: 8 }}>
              <input type="hidden" name="provider" value="GOOGLE" />
              <input type="hidden" name="seatId" value={seat.id} />
              <button className="ghost" type="submit">Reconnect</button>
            </form>
            <form action={removeSeat}>
              <input type="hidden" name="seatId" value={seat.id} />
              <input type="hidden" name="kind" value="email" />
              <button className="warn" type="submit">Remove seat</button>
            </form>
          </article>
        ))}
      </div>
    </main>
  );
}

function SeatHours({ start, end, zone, days }: { start: string; end: string; zone: string; days: number[] | null }) {
  const selected = new Set((days ?? [1, 2, 3, 4, 5]).map(String));
  return (
    <>
      <label>Timezone<input name="timezone" defaultValue={zone} /></label>
      <div className="limits">
        <label>Start<input name="launchStart" defaultValue={start} /></label>
        <label>End<input name="launchEnd" defaultValue={end} /></label>
      </div>
      <div className="days">
        {DAYS.map(([value, label]) => (
          <label key={value}><input type="checkbox" name="activeDays" value={value} defaultChecked={selected.has(value)} /> {label}</label>
        ))}
      </div>
    </>
  );
}

function Field({ name, label, value }: { name: string; label: string; value: number }) {
  return <label>{label}<input name={name} type="number" min={0} defaultValue={value} /></label>;
}

interface LinkedinSeat {
  id: string;
  unipile_status: string;
  paused_reason: string | null;
  timezone: string;
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
}

interface EmailSeat {
  id: string;
  address: string;
  unipile_status: string;
  paused_reason: string | null;
  timezone: string;
  daily_limit: number;
  launch_start: string;
  launch_end: string;
  active_days: number[] | null;
}
