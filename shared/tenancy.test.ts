import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { contacts, suppressions } from "./db/schema.js";
import { forOrg } from "./db/scope.js";
import { listContacts, listSuppressions } from "./db/queries.js";
import { ensureOrg } from "./db/org.js";
import { insertOrg, insertUser, resetTables, testDatabase } from "./db/test-support.js";

describe("tenancy", () => {
  let db: Awaited<ReturnType<typeof testDatabase>>["db"];
  let sql: Awaited<ReturnType<typeof testDatabase>>["sql"];

  beforeEach(async () => {
    ({ db, sql } = await testDatabase());
    await resetTables(sql);
  });

  afterAll(async () => {
    const conn = await testDatabase();
    await conn.sql.end({ timeout: 1 });
  });

  it("keeps profile_url as the person key and org_id on campaign steps", async () => {
    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'contacts_org_profile_idx'
    `;
    expect(indexes[0]?.indexdef).toContain("profile_url");
    const column = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'campaign_steps' AND column_name = 'org_id'
    `;
    expect(column[0]?.is_nullable).toBe("NO");
    const orgId = await insertOrg(sql, "Schema");
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO agents (org_id) VALUES (${orgId}) RETURNING id
    `;
    await expect(sql`
      INSERT INTO signals (org_id, agent_id, type, value, signal_key)
      VALUES (${orgId}, ${agent!.id}, 'profile_viewers', 'seat', 'profile_viewers:seat')
    `).rejects.toThrow(/profile_viewers|check/i);
  });

  it("does not let forOrg read another org", async () => {
    const orgA = await insertOrg(sql, "A");
    const orgB = await insertOrg(sql, "B");
    await sql`
      INSERT INTO contacts (org_id, profile_url, status)
      VALUES (${orgA}, 'https://www.linkedin.com/in/ada', 'approved')
    `;
    const seen = await listContacts(db, orgB);
    expect(seen).toHaveLength(0);
    const own = await db.select().from(contacts).where(forOrg(orgA, contacts.orgId));
    expect(own).toHaveLength(1);
    expect(own[0]?.profileUrl).toContain("/in/ada");
  });

  it("includes global suppressions for every org", async () => {
    const orgA = await insertOrg(sql, "A");
    const orgB = await insertOrg(sql, "B");
    await db.insert(suppressions).values({
      orgId: null,
      profileUrl: "https://www.linkedin.com/in/ada",
      reason: "opt-out",
      confirmed: true,
    });
    await db.insert(suppressions).values({
      orgId: orgA,
      email: "a@example.com",
      reason: "unsubscribe",
      confirmed: true,
    });
    const forB = await listSuppressions(db, orgB);
    expect(forB.map((row) => row.profileUrl)).toContain("https://www.linkedin.com/in/ada");
    expect(forB.some((row) => row.email === "a@example.com")).toBe(false);
    const scoped = await db.select().from(suppressions).where(eq(suppressions.orgId, orgA));
    expect(scoped).toHaveLength(1);
  });

  it("blocks anon and authenticated from other orgs and from shared tables", async () => {
    const orgA = await insertOrg(sql, "A");
    const orgB = await insertOrg(sql, "B");
    const userA = await insertUser(sql, orgA, "a@example.com");
    await insertUser(sql, orgB, "b@example.com");
    await sql`
      INSERT INTO contacts (org_id, profile_url, status)
      VALUES (${orgA}, 'https://www.linkedin.com/in/ada', 'approved'),
             (${orgB}, 'https://www.linkedin.com/in/bea', 'approved')
    `;
    await sql`
      INSERT INTO profiles_cache (profile_url, name) VALUES ('https://www.linkedin.com/in/ada', 'Ada')
    `;
    const asA = await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claim.sub', ${userA}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      return tx<{ profile_url: string }[]>`SELECT profile_url FROM contacts ORDER BY profile_url`;
    });
    expect(asA.map((row) => row.profile_url)).toEqual(["https://www.linkedin.com/in/ada"]);
    const anon = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE anon`;
      return tx`SELECT profile_url FROM contacts`;
    });
    expect(anon).toHaveLength(0);
    const sharedRows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claim.sub', ${userA}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      return tx`SELECT profile_url FROM profiles_cache`;
    });
    expect(sharedRows).toHaveLength(0);
    const updated = await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claim.sub', ${userA}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      return tx`
        UPDATE contacts SET status = 'rejected'
        WHERE profile_url = 'https://www.linkedin.com/in/bea'
        RETURNING id
      `;
    });
    expect(updated).toHaveLength(0);
  });

  it("creates one org for the first session and reuses it", async () => {
    const id = crypto.randomUUID();
    const first = await ensureOrg(db, { id, email: "owner@example.com" });
    const second = await ensureOrg(db, { id, email: "owner@example.com" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ orgId: first.orgId, created: false });
    const orgs = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM organizations`;
    expect(orgs[0]?.n).toBe(1);
  });
});
