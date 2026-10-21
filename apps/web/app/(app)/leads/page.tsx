import { desc } from "drizzle-orm";
import { forOrg } from "../../../../../shared/db/scope.js";
import { contacts } from "../../../../../shared/db/schema.js";
import { requireOrg } from "../org.js";
import { Shell, buttonStyle, fieldStyle, inputStyle } from "../shell.js";
import { approveLeadAction, rejectLeadAction } from "./actions.js";

export default async function LeadsPage() {
  const { db, orgId } = await requireOrg();
  const rows = await db.select().from(contacts).where(forOrg(orgId, contacts.orgId)).orderBy(desc(contacts.createdAt)).limit(100);
  const waiting = rows.filter((row) => row.status === "pending_review");
  const rest = rows.filter((row) => row.status !== "pending_review");

  return (
    <Shell title="Leads">
      <p>A rejected lead stays rejected. Approving a pending lead marks it approved. The person key is the LinkedIn profile URL.</p>
      <h2>Waiting for review ({waiting.length})</h2>
      {waiting.length === 0 ? <p>No leads are waiting.</p> : waiting.map((row) => (
        <article key={row.id} style={{ border: "1px solid #e2dcd0", background: "#fff", padding: 12, marginBottom: 12 }}>
          <strong>{row.name ?? row.profileUrl}</strong>
          <p>{row.title ?? "No title"}{row.company ? ` · ${row.company}` : ""}</p>
          <p>Score {row.fitScore ?? "—"} {row.scoreReason ? `· ${row.scoreReason}` : ""}</p>
          <p style={{ wordBreak: "break-all" }}>{row.profileUrl}</p>
          <form action={approveLeadAction}>
            <input type="hidden" name="contactId" value={row.id} />
            <button style={buttonStyle} type="submit">Approve</button>
          </form>
          <form action={rejectLeadAction}>
            <input type="hidden" name="contactId" value={row.id} />
            <label style={fieldStyle}>Reason<input name="reason" required style={inputStyle} /></label>
            <button style={{ ...buttonStyle, background: "#6b3a2a" }} type="submit">Reject</button>
          </form>
        </article>
      ))}
      <h2>Everyone else</h2>
      {rest.length === 0 ? <p>No other leads.</p> : (
        <ul>
          {rest.map((row) => (
            <li key={row.id}>{row.name ?? row.profileUrl} — {row.status}{row.rejectedReason ? ` (${row.rejectedReason})` : ""}</li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
