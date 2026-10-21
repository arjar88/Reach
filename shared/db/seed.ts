import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

const ORG_ID = "00000000-0000-4000-8000-000000000010";
const USER_ID = "00000000-0000-4000-8000-000000000011";
const LIST_ID = "00000000-0000-4000-8000-000000000012";
const AGENT_ID = "00000000-0000-4000-8000-000000000013";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000014";

const url = process.env.DATABASE_URL_SESSION ?? "postgres://reach:reach@127.0.0.1:5432/reach";

async function seed() {
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql, { schema });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: "Reach Pilot",
    plan: "pilot",
    timezone: "Asia/Jerusalem",
  }).onConflictDoNothing();
  await db.insert(schema.users).values({
    id: USER_ID,
    orgId: ORG_ID,
    email: "pilot@reach.local",
    role: "owner",
  }).onConflictDoNothing();
  await db.insert(schema.lists).values({ id: LIST_ID, orgId: ORG_ID, name: "Pilot list" }).onConflictDoNothing();
  await db.insert(schema.agents).values({
    id: AGENT_ID,
    orgId: ORG_ID,
    listId: LIST_ID,
    status: "draft",
    jobTitles: ["Founder"],
    industries: ["Software"],
    companySizes: ["11-50"],
    locations: ["Israel"],
    mandatoryKeywords: ["outreach"],
    excludedCompanies: [],
    excludedNames: [],
    minScore: 0.7,
    reviewMode: true,
  }).onConflictDoNothing();
  await db.insert(schema.campaigns).values({
    id: CAMPAIGN_ID,
    orgId: ORG_ID,
    listId: LIST_ID,
    name: "Pilot",
    linkedinSeatId: null,
    active: false,
    reviewMessages: true,
  }).onConflictDoNothing();
  const steps = [
    { position: 1, type: "visit", delayDays: 0 },
    { position: 2, type: "invite", delayDays: 1 },
    { position: 3, type: "message", delayDays: 1 },
    { position: 4, type: "message", delayDays: 2 },
  ];
  for (const step of steps) {
    await sql`
      INSERT INTO campaign_steps (org_id, campaign_id, position, type, delay_days, mode)
      VALUES (${ORG_ID}, ${CAMPAIGN_ID}, ${step.position}, ${step.type}, ${step.delayDays}, 'ai')
      ON CONFLICT (campaign_id, position) DO NOTHING
    `;
  }
  const people = [
    ["https://www.linkedin.com/in/ada-pilot", "Ada Pilot", "Ada"],
    ["https://www.linkedin.com/in/ben-pilot", "Ben Pilot", "Ben"],
  ];
  for (const [profile, name, first] of people) {
    await sql`
      INSERT INTO contacts (org_id, list_id, agent_id, profile_url, name, first_name_clean, status, signals)
      VALUES (${ORG_ID}, ${LIST_ID}, ${AGENT_ID}, ${profile}, ${name}, ${first}, 'approved', '[]'::jsonb)
      ON CONFLICT (org_id, profile_url) DO NOTHING
    `;
  }
  await sql.end();
  console.log(`Seeded org ${ORG_ID} user ${USER_ID} (${url})`);
}

seed().catch((error) => {
  console.error(error instanceof Error ? error.message : "seed failed");
  process.exit(1);
});
