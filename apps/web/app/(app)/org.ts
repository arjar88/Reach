import { ensureOrg } from "@reach/shared";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";

/** Session org. The first sign-in inserts one organization and an owner row. */
export async function requireOrg() {
  const supabase = await createClient();
  if (!supabase) throw new Error("Supabase is not configured");
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user?.email) throw new Error("Sign in required");
  const { db } = getDb();
  const { orgId } = await ensureOrg(db, { id: user.id, email: user.email });
  return { db, orgId, userId: user.id, email: user.email };
}
