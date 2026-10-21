import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { companiesCache, postEngagers, profilesCache, scrapedPosts, suppressions } from "./schema.js";

/** Every org-table query goes through this. A missing org id throws. */
export function forOrg(orgId: string, column: AnyColumn): SQL {
  if (!orgId) throw new Error("forOrg requires orgId");
  return eq(column, orgId);
}

/** This org's suppressions plus global rows (org_id null). */
export function suppressionsFor(orgId: string): SQL {
  if (!orgId) throw new Error("suppressionsFor requires orgId");
  return or(eq(suppressions.orgId, orgId), isNull(suppressions.orgId))!;
}

export function orgAnd(orgId: string, column: AnyColumn, extra: SQL): SQL {
  return and(forOrg(orgId, column), extra)!;
}

/** Shared scrape tables. They have no org_id. */
export const shared = {
  scrapedPosts,
  postEngagers,
  profilesCache,
  companiesCache,
};
