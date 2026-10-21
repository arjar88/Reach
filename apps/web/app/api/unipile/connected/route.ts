import { NextResponse } from "next/server";
import { createUnipile } from "../../../../../../shared/providers/unipile.js";
import { database } from "../../../../lib/db.js";

/**
 * One-time callback. The session row is consumed only when it is unused and unexpired.
 * Connecting an account never activates a campaign.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session") ?? "";
  const accountId = url.searchParams.get("account_id") ?? url.searchParams.get("accountId") ?? "";
  const accounts = new URL("/accounts", url.origin);
  if (!sessionId || !accountId) {
    accounts.searchParams.set("error", "Missing connect session");
    return NextResponse.redirect(accounts);
  }
  const { sql } = database();
  const consumed = await sql<{ org_id: string; user_id: string; provider: string; type: string; account_id: string | null }[]>`
    UPDATE connect_sessions
    SET used_at = now(), updated_at = now()
    WHERE id = ${sessionId} AND used_at IS NULL AND expires_at > now()
    RETURNING org_id, user_id, provider, type, account_id
  `;
  const session = consumed[0];
  if (!session) {
    accounts.searchParams.set("error", "Connect link already used or expired");
    return NextResponse.redirect(accounts);
  }
  const unipile = createUnipile();
  try {
    const account = await unipile.getAccount(accountId);
    if (session.provider === "LINKEDIN" || account.type.toUpperCase().includes("LINKEDIN")) {
      const profile = await unipile.getOwnProfile(accountId);
      const clash = await sql<{ id: string }[]>`
        SELECT id FROM linkedin_seats
        WHERE linkedin_provider_id = ${profile.providerId}
          AND unipile_account_id <> ${accountId}
      `;
      if (clash.length) {
        await unipile.deleteAccount(accountId);
        accounts.searchParams.set("error", "That LinkedIn account is already connected");
        return NextResponse.redirect(accounts);
      }
      if (session.type === "reconnect" && session.account_id) {
        await sql`
          UPDATE linkedin_seats SET
            unipile_account_id = ${accountId},
            linkedin_provider_id = COALESCE(linkedin_provider_id, ${profile.providerId}),
            unipile_status = ${account.status || "OK"},
            status_changed_at = now(),
            is_premium = ${profile.premium},
            connections_count = ${profile.connections},
            connected_at = COALESCE(connected_at, now()),
            paused_reason = NULL,
            updated_at = now()
          WHERE org_id = ${session.org_id} AND unipile_account_id = ${session.account_id}
        `;
      } else {
        await sql`
          INSERT INTO linkedin_seats (
            org_id, user_id, unipile_account_id, linkedin_provider_id, unipile_status,
            status_changed_at, is_premium, connections_count, connected_at
          ) VALUES (
            ${session.org_id}, ${session.user_id}, ${accountId}, ${profile.providerId},
            ${account.status || "OK"}, now(), ${profile.premium}, ${profile.connections}, now()
          )
          ON CONFLICT (unipile_account_id) DO UPDATE SET
            linkedin_provider_id = COALESCE(linkedin_seats.linkedin_provider_id, EXCLUDED.linkedin_provider_id),
            unipile_status = EXCLUDED.unipile_status,
            status_changed_at = now(),
            is_premium = EXCLUDED.is_premium,
            connections_count = EXCLUDED.connections_count,
            connected_at = COALESCE(linkedin_seats.connected_at, EXCLUDED.connected_at),
            paused_reason = NULL,
            updated_at = now()
        `;
      }
    } else {
      if (session.type === "reconnect" && session.account_id) {
        await sql`
          UPDATE email_seats SET
            unipile_account_id = ${accountId},
            unipile_status = ${account.status || "OK"},
            status_changed_at = now(),
            paused_reason = NULL,
            updated_at = now()
          WHERE org_id = ${session.org_id} AND unipile_account_id = ${session.account_id}
        `;
      } else {
        await sql`
          INSERT INTO email_seats (
            org_id, user_id, address, unipile_account_id, unipile_status, status_changed_at
          ) VALUES (
            ${session.org_id}, ${session.user_id}, ${accountId}, ${accountId},
            ${account.status || "OK"}, now()
          )
          ON CONFLICT (unipile_account_id) DO UPDATE SET
            unipile_status = EXCLUDED.unipile_status,
            status_changed_at = now(),
            paused_reason = NULL,
            updated_at = now()
        `;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save the account";
    accounts.searchParams.set("error", message);
    return NextResponse.redirect(accounts);
  }
  accounts.searchParams.set("connected", "1");
  return NextResponse.redirect(accounts);
}
