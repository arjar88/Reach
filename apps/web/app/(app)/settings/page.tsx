import { eq } from "drizzle-orm";
import { emailSeats, organizations } from "../../../../../shared/db/schema.js";
import { forOrg } from "../../../../../shared/db/scope.js";
import { config } from "../../../../../shared/config.js";
import { requireOrg } from "../../../lib/session";
import { openPortal, refreshDomain, startCheckout } from "./actions";

export default async function SettingsPage() {
  const { db, orgId } = await requireOrg();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new Error("Organization not found");
  const seats = await db.select().from(emailSeats).where(forOrg(orgId, emailSeats.orgId));
  const stripeKey = Boolean(process.env.STRIPE_SECRET_KEY);
  const pilot = process.env.STRIPE_PRICE_PILOT;
  const basic = process.env.STRIPE_PRICE_BASIC;
  const topUp = process.env.STRIPE_PRICE_TOPUP;
  return (
    <main>
      <h1>Billing</h1>
      <section className="card">
        <p>Plan: {org.plan}</p>
        <p>Status: {org.status}</p>
        <p>Credits: {org.creditsBalance}</p>
        <p>Plan credits: {org.planCreditsBalance}</p>
      </section>
      {stripeKey && pilot ? (
        <form action={startCheckout}>
          <input type="hidden" name="price" value={pilot} />
          <input type="hidden" name="mode" value="subscription" />
          <button type="submit">Subscribe to pilot</button>
        </form>
      ) : <p className="error">Pilot checkout is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_PILOT.</p>}
      {stripeKey && basic ? (
        <form action={startCheckout}>
          <input type="hidden" name="price" value={basic} />
          <input type="hidden" name="mode" value="subscription" />
          <button type="submit">Subscribe to basic</button>
        </form>
      ) : <p className="error">Basic checkout is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_BASIC.</p>}
      {stripeKey && topUp ? (
        <form action={startCheckout}>
          <input type="hidden" name="price" value={topUp} />
          <input type="hidden" name="mode" value="payment" />
          <button type="submit">Buy {config.credits.topUp} credits</button>
        </form>
      ) : <p className="error">Top-up checkout is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_TOPUP.</p>}
      {stripeKey && org.stripeCustomerId ? (
        <form action={openPortal}>
          <button type="submit">Open billing portal</button>
        </form>
      ) : <p>The billing portal needs a Stripe secret and a Stripe customer on this organization.</p>}
      <h2>Email domains</h2>
      {seats.length === 0 ? <p>No email seats connected.</p> : seats.map((seat) => (
        <form action={refreshDomain} key={seat.id}>
          <input type="hidden" name="seatId" value={seat.id} />
          <p>{seat.address}</p>
          <p>{seat.domainCheck ? JSON.stringify(seat.domainCheck) : "DNS has not been checked."}</p>
          <button type="submit">Check DNS</button>
        </form>
      ))}
    </main>
  );
}
