import { receiveUnipileWebhook } from "../../../../../../shared/inbox/receive.js";
import { getDb } from "../../../../lib/db";

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.UNIPILE_WEBHOOK_SECRET;
  if (!expected) return Response.json({ error: "UNIPILE_WEBHOOK_SECRET is not set" }, { status: 500 });
  const payload = await request.json();
  const { db } = getDb();
  const result = await receiveUnipileWebhook(db, {
    secretHeader: request.headers.get("unipile-auth"),
    expectedSecret: expected,
    payload,
  });
  return new Response(null, { status: result.status });
}
