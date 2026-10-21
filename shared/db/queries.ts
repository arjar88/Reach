import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { contacts, jobRequests, suppressions } from "./schema.js";
import { forOrg, suppressionsFor } from "./scope.js";

export async function listContacts(db: Database, orgId: string) {
  return db.select().from(contacts).where(forOrg(orgId, contacts.orgId));
}

export async function listSuppressions(db: Database, orgId: string) {
  return db.select().from(suppressions).where(suppressionsFor(orgId));
}

/** A job is visible only inside its org. Another org gets null, not the row. */
export async function readJobForOrg(db: Database, orgId: string, id: string) {
  const rows = await db.select({
    id: jobRequests.id,
    type: jobRequests.type,
    status: jobRequests.status,
    result: jobRequests.result,
    error: jobRequests.error,
  }).from(jobRequests).where(and(eq(jobRequests.id, id), forOrg(orgId, jobRequests.orgId))).limit(1);
  return rows[0] ?? null;
}
