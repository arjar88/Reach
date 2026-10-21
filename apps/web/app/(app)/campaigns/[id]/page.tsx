import Link from "next/link";
import { notFound } from "next/navigation";
import {
  activateCampaign,
  deactivateCampaign,
  deleteCampaign,
  duplicateCampaign,
  editHeld,
  approveHeld,
  saveCampaign,
} from "../../../../lib/actions/campaigns.js";
import { database } from "../../../../lib/db.js";
import { currentOrg } from "../../../../lib/session.js";
import { CampaignFields, type StepValue } from "../fields.js";

export const dynamic = "force-dynamic";

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; tab?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const auth = await currentOrg();
  if ("error" in auth) return <main><h1>Campaign</h1><p className="banner">{auth.error}</p></main>;
  const { sql } = database();
  const rows = await sql<CampaignRow[]>`
    SELECT id, name, list_id, goal, tone, language, review_messages, silent_visits,
           linkedin_seat_id, email_seat_id, active, has_contacts
    FROM campaigns WHERE id = ${id} AND org_id = ${auth.orgId}
  `;
  const campaign = rows[0];
  if (!campaign) notFound();
  const steps = await sql<StepValue[]>`
    SELECT position, type, delay_days AS "delayDays", mode, template, subject
    FROM campaign_steps WHERE campaign_id = ${id} AND org_id = ${auth.orgId}
    ORDER BY position
  `;
  const lists = await sql<{ id: string; name: string }[]>`SELECT id, name FROM lists WHERE org_id = ${auth.orgId} ORDER BY name`;
  const linkedin = await sql<{ id: string; unipile_status: string }[]>`
    SELECT id, unipile_status FROM linkedin_seats WHERE org_id = ${auth.orgId}
  `;
  const email = await sql<{ id: string; address: string }[]>`SELECT id, address FROM email_seats WHERE org_id = ${auth.orgId}`;
  const held = query.tab === "held"
    ? await sql<Held[]>`
        SELECT a.id, a.type, a.content, a.subject, a.check_failed_reason, c.name
        FROM actions a
        JOIN contacts c ON c.id = a.contact_id
        WHERE a.org_id = ${auth.orgId} AND c.campaign_id = ${id} AND a.status = 'pending_approval'
        ORDER BY a.created_at
      `
    : [];
  return (
    <main>
      <h1>{campaign.name}</h1>
      <p className="meta">{campaign.active ? "Active" : "Draft"}{campaign.has_contacts ? " · has contacts" : " · no contacts yet"}</p>
      {query.error ? <p className="banner">{query.error}</p> : null}
      <div className="tabs">
        <Link href={`/campaigns/${id}`}>Steps</Link>
        <Link href={`/campaigns/${id}?tab=held`}>Held messages</Link>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <form action={activateCampaign}><input type="hidden" name="id" value={id} /><button type="submit">Activate</button></form>
        <form action={deactivateCampaign}><input type="hidden" name="id" value={id} /><button className="ghost" type="submit">Deactivate</button></form>
        <form action={duplicateCampaign}><input type="hidden" name="id" value={id} /><button className="ghost" type="submit">Duplicate</button></form>
        <form action={deleteCampaign}><input type="hidden" name="id" value={id} /><button className="warn" type="submit">Delete</button></form>
      </div>
      {query.tab === "held" ? (
        <section className="grid">
          {held.length === 0 ? <p className="meta">Nothing is waiting for review.</p> : null}
          {held.map((action) => (
            <article className="card" key={action.id}>
              <h2>{action.type} · {action.name ?? "Contact"}</h2>
              {action.check_failed_reason ? <p className="status-warn">{action.check_failed_reason}</p> : null}
              <form action={editHeld}>
                <input type="hidden" name="actionId" value={action.id} />
                <input type="hidden" name="campaignId" value={id} />
                <label>Subject<input name="subject" defaultValue={action.subject ?? ""} /></label>
                <label>Message<textarea name="content" defaultValue={action.content ?? ""} /></label>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="ghost" type="submit">Save edit</button>
                </div>
              </form>
              <form action={approveHeld} style={{ marginTop: 8 }}>
                <input type="hidden" name="actionId" value={action.id} />
                <input type="hidden" name="campaignId" value={id} />
                <button type="submit">Approve</button>
              </form>
            </article>
          ))}
        </section>
      ) : (
        <form action={saveCampaign} className="card">
          <CampaignFields
            lists={lists}
            linkedin={linkedin}
            email={email}
            steps={steps}
            locked={campaign.has_contacts}
            campaign={{
              id: campaign.id,
              name: campaign.name,
              listId: campaign.list_id,
              goal: campaign.goal,
              tone: campaign.tone,
              language: campaign.language,
              reviewMessages: campaign.review_messages,
              silentVisits: campaign.silent_visits,
              linkedinSeatId: campaign.linkedin_seat_id,
              emailSeatId: campaign.email_seat_id,
            }}
          />
          <button type="submit">Save</button>
        </form>
      )}
    </main>
  );
}

interface CampaignRow {
  id: string;
  name: string;
  list_id: string;
  goal: string;
  tone: string;
  language: string;
  review_messages: boolean;
  silent_visits: boolean;
  linkedin_seat_id: string | null;
  email_seat_id: string | null;
  active: boolean;
  has_contacts: boolean;
}

interface Held {
  id: string;
  type: string;
  content: string | null;
  subject: string | null;
  check_failed_reason: string | null;
  name: string | null;
}
