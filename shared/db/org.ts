import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { organizations, users } from "./schema.js";

/** Create the org and owner row the first time a session appears. Safe to call twice. */
export async function ensureOrg(db: Database, user: { id: string; email: string }): Promise<{ orgId: string; created: boolean }> {
  const existing = await db.select({ orgId: users.orgId }).from(users).where(eq(users.id, user.id)).limit(1);
  if (existing[0]) return { orgId: existing[0].orgId, created: false };
  const name = `${user.email.split("@")[0] || "Workspace"}'s workspace`;
  try {
    return await db.transaction(async (tx) => {
      const again = await tx.select({ orgId: users.orgId }).from(users).where(eq(users.id, user.id)).limit(1);
      if (again[0]) return { orgId: again[0].orgId, created: false };
      const [org] = await tx.insert(organizations).values({ name }).returning({ id: organizations.id });
      if (!org) throw new Error("Could not create organization");
      await tx.insert(users).values({ id: user.id, orgId: org.id, email: user.email, role: "owner" });
      return { orgId: org.id, created: true };
    });
  } catch (error) {
    const raced = await db.select({ orgId: users.orgId }).from(users).where(eq(users.id, user.id)).limit(1);
    if (raced[0]) return { orgId: raced[0].orgId, created: false };
    throw error;
  }
}
