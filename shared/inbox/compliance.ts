import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { actions, contacts, postEngagers, profilesCache, seenPeople, suppressions } from "../db/schema.js";
import { forOrg } from "../db/scope.js";
import { normalizeProfileUrl } from "../profiles.js";
import { onOptOut, onUnsubscribe } from "../sequence.js";
import { applyEffects, saveSnap, toSnap } from "./persist.js";
import type { Sql } from "postgres";

async function deleteSharedPerson(db: Database, profileUrl: string): Promise<void> {
  await db.delete(postEngagers).where(eq(postEngagers.profileUrl, profileUrl));
  await db.delete(profilesCache).where(eq(profilesCache.profileUrl, profileUrl));
  await db.delete(seenPeople).where(eq(seenPeople.profileUrl, profileUrl));
}

/** Unsubscribe keeps the contact and the thread, and adds an org suppression. */
export async function applyUnsubscribe(db: Database, opts: { orgId: string; email: string }): Promise<{ contacts: number }> {
  const email = opts.email.trim().toLowerCase();
  await db.execute(sql`
    INSERT INTO suppressions (org_id, email, reason, confirmed)
    VALUES (${opts.orgId}, ${email}, 'unsubscribe', true)
    ON CONFLICT (org_id, lower(email)) WHERE org_id IS NOT NULL AND email IS NOT NULL DO NOTHING
  `);
  const rows = await db.select().from(contacts).where(and(forOrg(opts.orgId, contacts.orgId), sql`lower(${contacts.email}) = ${email}`));
  for (const row of rows) {
    const next = onUnsubscribe(toSnap(row));
    await saveSnap(db, next.contact);
    await applyEffects(db, row.id, next.effects);
    if (row.profileUrl) {
      await db.execute(sql`
        INSERT INTO suppressions (org_id, profile_url, reason, confirmed)
        VALUES (${opts.orgId}, ${row.profileUrl}, 'unsubscribe', true)
        ON CONFLICT (org_id, profile_url) WHERE org_id IS NOT NULL AND profile_url IS NOT NULL DO NOTHING
      `);
    }
  }
  return { contacts: rows.length };
}

/** Opt-out stores a global suppression on the profile URL and deletes the contact everywhere. */
export async function applyProfileOptOut(db: Database, profileInput: string): Promise<{ deleted: number }> {
  const profileUrl = normalizeProfileUrl(profileInput);
  if (!profileUrl) throw new Error("Enter a LinkedIn profile URL");
  await db.execute(sql`
    INSERT INTO suppressions (org_id, profile_url, reason, confirmed)
    VALUES (NULL, ${profileUrl}, 'opt_out', true)
    ON CONFLICT (profile_url) WHERE org_id IS NULL AND profile_url IS NOT NULL DO NOTHING
  `);
  const rows = await db.select().from(contacts).where(eq(contacts.profileUrl, profileUrl));
  for (const row of rows) onOptOut(toSnap(row));
  if (rows.length) {
    await db.delete(actions).where(inArray(actions.contactId, rows.map((row) => row.id)));
  }
  const deleted = await db.delete(contacts).where(eq(contacts.profileUrl, profileUrl)).returning({ id: contacts.id });
  await deleteSharedPerson(db, profileUrl);
  return { deleted: deleted.length };
}

/** Confirmed email opt-out. Global suppression, then every matching contact is deleted. */
export async function applyEmailOptOut(db: Database, emailInput: string): Promise<{ deleted: number }> {
  const email = emailInput.trim().toLowerCase();
  await db.execute(sql`
    INSERT INTO suppressions (org_id, email, reason, confirmed)
    VALUES (NULL, ${email}, 'opt_out', true)
    ON CONFLICT (lower(email)) WHERE org_id IS NULL AND email IS NOT NULL DO NOTHING
  `);
  const rows = await db.select().from(contacts).where(sql`lower(${contacts.email}) = ${email}`);
  const urls = [...new Set(rows.map((row) => row.profileUrl))];
  if (rows.length) await db.delete(actions).where(inArray(actions.contactId, rows.map((row) => row.id)));
  const deleted = await db.delete(contacts).where(sql`lower(${contacts.email}) = ${email}`).returning({ id: contacts.id });
  for (const url of urls) await deleteSharedPerson(db, url);
  return { deleted: deleted.length };
}

export async function suppressionBlocks(sql: Sql, orgId: string, profileUrl: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM suppressions
    WHERE profile_url = ${profileUrl}
      AND (org_id = ${orgId} OR org_id IS NULL)
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function globalProfileSuppressed(db: Database, profileUrl: string): Promise<boolean> {
  const rows = await db.select({ id: suppressions.id }).from(suppressions).where(and(
    isNull(suppressions.orgId),
    eq(suppressions.profileUrl, profileUrl),
  )).limit(1);
  return rows.length > 0;
}
