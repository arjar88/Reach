import { dashboardFunnel } from "../../../../../shared/inbox/dashboard.js";
import { requireOrg } from "../../../lib/session";

export default async function DashboardPage() {
  const { db, orgId } = await requireOrg();
  const funnel = await dashboardFunnel(db, orgId);
  const contactRows = Object.entries(funnel.contacts);
  const actionRows = Object.entries(funnel.actions);
  return (
    <main>
      <h1>Dashboard</h1>
      <section className="card">
        <h2>Contacts</h2>
        {contactRows.length === 0 ? <p>No contacts yet.</p> : (
          <ul>
            {contactRows.map(([status, count]) => <li key={status}>{status}: {count}</li>)}
          </ul>
        )}
        <p>Accepted: {funnel.accepted}</p>
        <p>Replies: {funnel.replies}</p>
      </section>
      <section className="card">
        <h2>Actions</h2>
        {actionRows.length === 0 ? <p>No actions yet.</p> : (
          <ul>
            {actionRows.map(([type, count]) => <li key={type}>{type}: {count}</li>)}
          </ul>
        )}
      </section>
    </main>
  );
}
