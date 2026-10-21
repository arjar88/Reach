import { NextResponse } from "next/server";
import { config } from "../../../../../../shared/config.js";
import { createUnipile } from "../../../../../../shared/providers/unipile.js";
import { database } from "../../../../lib/db.js";
import { currentOrg } from "../../../../lib/session.js";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await currentOrg();
  if ("error" in auth) {
    return NextResponse.redirect(new URL(`/accounts?error=${encodeURIComponent(auth.error)}`, request.url));
  }
  const form = await request.formData();
  const provider = String(form.get("provider") ?? "LINKEDIN");
  const seatId = String(form.get("seatId") ?? "");
  const kind = provider === "LINKEDIN" ? "linkedin" : "email";
  const { sql } = database();
  let accountId: string | null = null;
  if (seatId) {
    const rows = kind === "email"
      ? await sql<{ unipile_account_id: string }[]>`
          SELECT unipile_account_id FROM email_seats WHERE id = ${seatId} AND org_id = ${auth.orgId}
        `
      : await sql<{ unipile_account_id: string }[]>`
          SELECT unipile_account_id FROM linkedin_seats WHERE id = ${seatId} AND org_id = ${auth.orgId}
        `;
    accountId = rows[0]?.unipile_account_id ?? null;
    if (!accountId) {
      return NextResponse.redirect(new URL("/accounts?error=Seat%20not%20found", request.url));
    }
  }
  const expires = new Date(Date.now() + config.connectSessionMinutes * 60_000);
  const created = await sql<{ id: string }[]>`
    INSERT INTO connect_sessions (org_id, user_id, provider, type, account_id, expires_at)
    VALUES (
      ${auth.orgId}, ${auth.userId}, ${provider}, ${accountId ? "reconnect" : "create"},
      ${accountId}, ${expires}
    )
    RETURNING id
  `;
  const sessionId = created[0]?.id;
  if (!sessionId) {
    return NextResponse.redirect(new URL("/accounts?error=Could%20not%20start%20connect", request.url));
  }
  const appUrl = process.env.APP_URL ?? new URL(request.url).origin;
  try {
    const link = await createUnipile().createHostedLink({
      sessionId,
      type: accountId ? "reconnect" : "create",
      providers: [provider === "OUTLOOK" ? "OUTLOOK" : provider === "GOOGLE" ? "GOOGLE" : "LINKEDIN"],
      notifyUrl: `${appUrl}/api/unipile/connected?session=${sessionId}`,
      successUrl: `${appUrl}/api/unipile/connected?session=${sessionId}`,
      failureUrl: `${appUrl}/accounts?connect=failed`,
      expiresOn: expires.toISOString(),
      reconnectAccountId: accountId ?? undefined,
    });
    return NextResponse.redirect(link.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unipile is not configured";
    return NextResponse.redirect(new URL(`/accounts?error=${encodeURIComponent(message)}`, request.url));
  }
}
