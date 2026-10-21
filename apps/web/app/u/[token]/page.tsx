import { applyUnsubscribe } from "../../../../../shared/inbox/compliance.js";
import { verifyUnsubscribe } from "../../../../../shared/signing.js";
import { getDb } from "../../../lib/db";
import { limitPublic } from "../../../lib/public";

export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const payload = verifyUnsubscribe(token);
  if (!payload) return <main><h1>Unsubscribe</h1><p className="error">This unsubscribe link is invalid.</p></main>;
  await limitPublic();
  const { db } = getDb();
  const result = await applyUnsubscribe(db, payload);
  return (
    <main>
      <h1>Unsubscribed</h1>
      <p>We stopped new messages for {result.contacts} contact{result.contacts === 1 ? "" : "s"} and kept the conversation.</p>
    </main>
  );
}
