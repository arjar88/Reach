import { redirect } from "next/navigation";
import { requireOrg as loadOrg } from "../app/(app)/org";
import { getDb } from "./db";

/** Inbox, dashboard, and settings. Redirects when the session is missing. */
export async function requireOrg() {
  try {
    const org = await loadOrg();
    return { ...org, sql: getDb().sql, user: { id: org.userId, email: org.email } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Sign in required" || message === "Supabase is not configured") redirect("/sign-in");
    throw error;
  }
}

/** Accounts and campaigns render the error instead of redirecting. */
export async function currentOrg(): Promise<{ orgId: string; userId: string } | { error: string }> {
  try {
    const org = await loadOrg();
    return { orgId: org.orgId, userId: org.userId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Sign in required" };
  }
}
