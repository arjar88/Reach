import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  const value = process.env.SIGNING_SECRET;
  if (!value) throw new Error("SIGNING_SECRET is not set");
  return value;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface UnsubPayload {
  orgId: string;
  email: string;
}

export interface OptOutConfirmPayload {
  email: string;
}

function sign(body: string): string {
  const mac = createHmac("sha256", secret()).update(body).digest();
  return `${b64url(Buffer.from(body))}.${b64url(mac)}`;
}

function read(token: string): string | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(Buffer.from(body, "base64url")).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}

export function signUnsubscribe(payload: UnsubPayload): string {
  return sign(JSON.stringify({ k: "u", orgId: payload.orgId, email: payload.email.toLowerCase() }));
}

export function verifyUnsubscribe(token: string): UnsubPayload | null {
  const raw = read(token);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { k?: string; orgId?: string; email?: string };
    if (parsed.k !== "u" || !parsed.orgId || !parsed.email) return null;
    return { orgId: parsed.orgId, email: parsed.email };
  } catch {
    return null;
  }
}

export function signOptOutConfirm(payload: OptOutConfirmPayload): string {
  return sign(JSON.stringify({ k: "o", email: payload.email.toLowerCase() }));
}

export function verifyOptOutConfirm(token: string): OptOutConfirmPayload | null {
  const raw = read(token);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { k?: string; email?: string };
    if (parsed.k !== "o" || !parsed.email) return null;
    return { email: parsed.email };
  } catch {
    return null;
  }
}
