import { createHmac, timingSafeEqual } from "node:crypto";
import { asRecord, liveHttp, requireEnv, type HttpClient } from "./http.js";

export interface StripeEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface StripeClient {
  verify(rawBody: string, signature: string | null, secret?: string): StripeEvent;
  createCheckout(opts: { customerId?: string | null; priceId: string; orgId: string; mode: "subscription" | "payment"; credits?: number }): Promise<{ url: string }>;
  createPortal(customerId: string): Promise<{ url: string }>;
}

function parseEvent(rawBody: string): StripeEvent {
  const json = JSON.parse(rawBody) as Record<string, unknown>;
  return { id: String(json.id ?? ""), type: String(json.type ?? ""), data: asRecord(asRecord(json.data).object) };
}

export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowMs = Date.now()): StripeEvent {
  if (!header) throw new Error("Missing Stripe signature");
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) throw new Error("Malformed Stripe signature");
  if (Math.abs(nowMs - Number(timestamp) * 1000) > 5 * 60_000) throw new Error("Stale Stripe signature");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Bad Stripe signature");
  return parseEvent(rawBody);
}

export function createStripe(http: HttpClient = liveHttp): StripeClient {
  return {
    verify(rawBody, signature, secret = process.env.STRIPE_WEBHOOK_SECRET) {
      if (!secret) requireEnv("STRIPE_WEBHOOK_SECRET");
      return verifyStripeSignature(rawBody, signature, secret!);
    },
    async createCheckout(opts) {
      const key = requireEnv("STRIPE_SECRET_KEY");
      const appUrl = process.env.APP_URL ?? "http://localhost:3000";
      const body = new URLSearchParams();
      body.set("mode", opts.mode);
      body.set("success_url", `${appUrl}/settings?billing=ok`);
      body.set("cancel_url", `${appUrl}/settings?billing=cancel`);
      body.set("line_items[0][price]", opts.priceId);
      body.set("line_items[0][quantity]", "1");
      body.set("metadata[org_id]", opts.orgId);
      if (opts.credits) body.set("metadata[credits]", String(opts.credits));
      body.set("metadata[kind]", opts.mode === "payment" ? "top_up" : "plan");
      if (opts.customerId) body.set("customer", opts.customerId);
      else body.set("customer_creation", "always");
      const response = await http("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const json = asRecord(response.json);
      const url = typeof json.url === "string" ? json.url : "";
      if (!url) throw new Error("Stripe did not return a checkout URL");
      return { url };
    },
    async createPortal(customerId) {
      const key = requireEnv("STRIPE_SECRET_KEY");
      const appUrl = process.env.APP_URL ?? "http://localhost:3000";
      const body = new URLSearchParams({ customer: customerId, return_url: `${appUrl}/settings` });
      const response = await http("https://api.stripe.com/v1/billing_portal/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const url = asRecord(response.json).url;
      if (typeof url !== "string") throw new Error("Stripe did not return a portal URL");
      return { url };
    },
  };
}
