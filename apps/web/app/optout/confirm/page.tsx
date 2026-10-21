import { applyEmailOptOut } from "../../../../../shared/inbox/compliance.js";
import { verifyOptOutConfirm } from "../../../../../shared/signing.js";
import { getDb } from "../../../lib/db";
import { limitPublic } from "../../../lib/public";

export default async function ConfirmOptOutPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const params = await searchParams;
  if (!params.token) return <main><h1>Confirm opt-out</h1><p className="error">Missing confirmation token.</p></main>;
  const payload = verifyOptOutConfirm(params.token);
  if (!payload) return <main><h1>Confirm opt-out</h1><p className="error">This confirmation link is invalid.</p></main>;
  await limitPublic();
  const { db } = getDb();
  const result = await applyEmailOptOut(db, payload.email);
  return (
    <main>
      <h1>Opt-out confirmed</h1>
      <p>{result.deleted} contacts with that email were deleted, and the address is suppressed everywhere.</p>
    </main>
  );
}
