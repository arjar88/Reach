import { createStripe } from "../../../../../../shared/providers/stripe.js";
import { receiveStripeWebhook } from "../../../../../../shared/inbox/receive.js";
import { getDb } from "../../../../lib/db";

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  let event;
  try {
    event = createStripe().verify(raw, request.headers.get("stripe-signature"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Stripe webhook";
    return Response.json({ error: message }, { status: 400 });
  }
  const { db } = getDb();
  const result = await receiveStripeWebhook(db, event, JSON.parse(raw) as unknown);
  return new Response(null, { status: result.status });
}
