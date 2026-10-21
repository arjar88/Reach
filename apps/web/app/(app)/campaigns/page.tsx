import Link from "next/link";
import { saveCampaign } from "../../../lib/actions/campaigns.js";
import { database } from "../../../lib/db.js";
import { currentOrg } from "../../../lib/session.js";
import { CampaignFields } from "./fields.js";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const auth = await currentOrg();
  if ("error" in auth) {
    return <main><h1>Campaigns</h1><p className="banner">{auth.error}</p></main>;
  }
  const { sql } = database();
  const campaigns = await sql<{ id: string; name: string; active: boolean; has_contacts: boolean }[]>`
    SELECT id, name, active, has_contacts FROM campaigns WHERE org_id = ${auth.orgId} ORDER BY created_at DESC
  `;
  const lists = await sql<{ id: string; name: string }[]>`SELECT id, name FROM lists WHERE org_id = ${auth.orgId} ORDER BY name`;
  const linkedin = await sql<{ id: string; unipile_status: string }[]>`
    SELECT id, unipile_status FROM linkedin_seats WHERE org_id = ${auth.orgId} ORDER BY created_at
  `;
  const email = await sql<{ id: string; address: string }[]>`
    SELECT id, address FROM email_seats WHERE org_id = ${auth.orgId} ORDER BY created_at
  `;
  return (
    <main>
      <h1>Campaigns</h1>
      <p className="lede">A draft can omit its seat. Activate requires a seat, and a visit before any invite.</p>
      {params.error ? <p className="banner">{params.error}</p> : null}
      <table>
        <thead><tr><th>Name</th><th>State</th></tr></thead>
        <tbody>
          {campaigns.map((campaign) => (
            <tr key={campaign.id}>
              <td><Link href={`/campaigns/${campaign.id}`}>{campaign.name}</Link></td>
              <td className="meta">{campaign.active ? "Active" : "Draft"}{campaign.has_contacts ? " · has contacts" : ""}</td>
            </tr>
          ))}
          {campaigns.length === 0 ? <tr><td colSpan={2} className="meta">No campaigns yet.</td></tr> : null}
        </tbody>
      </table>
      <section className="card" style={{ marginTop: 20 }}>
        <h2>New campaign</h2>
        <form action={saveCampaign}>
          <CampaignFields lists={lists} linkedin={linkedin} email={email} steps={[]} locked={false} />
          <button type="submit">Save draft</button>
        </form>
      </section>
    </main>
  );
}
