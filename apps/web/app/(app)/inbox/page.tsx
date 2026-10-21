import { and, desc, eq } from "drizzle-orm";
import { contacts, emailSeats, linkedinSeats, threads } from "../../../../../shared/db/schema.js";
import { forOrg } from "../../../../../shared/db/scope.js";
import { requireOrg } from "../../../lib/session";
import { sendReply } from "./actions";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ queued?: string }> }) {
  const params = await searchParams;
  const { db, orgId } = await requireOrg();
  const rows = await db.select({
    id: threads.id,
    label: threads.label,
    aiDraft: threads.aiDraft,
    channel: threads.channel,
    contactId: threads.contactId,
    name: contacts.name,
  }).from(threads).innerJoin(contacts, eq(threads.contactId, contacts.id)).where(and(
    forOrg(orgId, threads.orgId),
    forOrg(orgId, contacts.orgId),
  )).orderBy(desc(threads.lastMessageAt));
  const linkedin = await db.select().from(linkedinSeats).where(forOrg(orgId, linkedinSeats.orgId));
  const emails = await db.select().from(emailSeats).where(forOrg(orgId, emailSeats.orgId));
  const linkedinSeatId = linkedin[0]?.id ?? "";
  const emailSeatId = emails[0]?.id ?? "";
  return (
    <main>
      <h1>Inbox</h1>
      {params.queued ? <p>Reply queued ({params.queued}). It sends as its own action.</p> : null}
      {rows.length === 0 ? <p>No replies yet.</p> : null}
      {rows.map((row) => (
        <article className="thread" key={row.id}>
          <h2>{row.name ?? "Contact"}</h2>
          <p>{row.channel}{row.label ? ` · ${row.label}` : ""}</p>
          {row.aiDraft ? <p>Draft: {row.aiDraft}</p> : <p>No draft yet.</p>}
          {linkedinSeatId || emailSeatId ? (
            <form action={sendReply}>
              <input type="hidden" name="contactId" value={row.contactId} />
              <input type="hidden" name="linkedinSeatId" value={linkedinSeatId} />
              <input type="hidden" name="emailSeatId" value={emailSeatId} />
              <label>
                Channel
                <select name="channel" defaultValue={row.channel}>
                  {linkedinSeatId ? <option value="linkedin">LinkedIn</option> : null}
                  {emailSeatId ? <option value="email">Email</option> : null}
                </select>
              </label>
              <label>
                Subject
                <input name="subject" type="text" />
              </label>
              <label>
                Reply
                <textarea name="body" required defaultValue={row.aiDraft ?? ""} rows={5} />
              </label>
              <button type="submit">Send reply</button>
            </form>
          ) : <p className="error">Connect a seat before replying.</p>}
        </article>
      ))}
    </main>
  );
}
