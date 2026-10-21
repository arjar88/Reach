import { and, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { actions, contacts } from "../db/schema.js";
import { forOrg } from "../db/scope.js";

export interface DashboardFunnel {
  contacts: Record<string, number>;
  actions: Record<string, number>;
  accepted: number;
  replies: number;
}

/** Counts come from this org's contacts and actions. */
export async function dashboardFunnel(db: Database, orgId: string): Promise<DashboardFunnel> {
  const contactRows = await db.select({
    status: contacts.status,
    count: sql<number>`count(*)::int`,
  }).from(contacts).where(forOrg(orgId, contacts.orgId)).groupBy(contacts.status);
  const actionRows = await db.select({
    type: actions.type,
    count: sql<number>`count(*)::int`,
  }).from(actions).where(forOrg(orgId, actions.orgId)).groupBy(actions.type);
  const acceptedRows = await db.select({ count: sql<number>`count(*)::int` }).from(contacts).where(and(
    forOrg(orgId, contacts.orgId),
    isNotNull(contacts.acceptedAt),
  ));
  const contactsByStatus: Record<string, number> = {};
  for (const row of contactRows) contactsByStatus[row.status] = Number(row.count);
  const actionsByType: Record<string, number> = {};
  for (const row of actionRows) actionsByType[row.type] = Number(row.count);
  return {
    contacts: contactsByStatus,
    actions: actionsByType,
    accepted: Number(acceptedRows[0]?.count ?? 0),
    replies: contactsByStatus.replied ?? 0,
  };
}
