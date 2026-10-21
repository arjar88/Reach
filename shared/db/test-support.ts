import { migrate } from "./migrate.js";
import { createDb, type Database } from "./client.js";
import type { Sql } from "postgres";

let ready: Promise<{ db: Database; sql: Sql }> | null = null;

export function testDatabase(): Promise<{ db: Database; sql: Sql }> {
  if (!ready) {
    ready = (async () => {
      const url = process.env.DATABASE_URL_SESSION ?? "postgres://reach:reach@127.0.0.1:5432/reach_test";
      await migrate(url);
      return createDb(url, "worker");
    })();
  }
  return ready;
}

export async function resetTables(sql: Sql): Promise<void> {
  await sql`
    TRUNCATE
      thread_messages, threads, actions, campaign_steps, campaigns, contacts, seen_people,
      signals, agents, lists, seat_quota_blocks, provider_calls, email_seats, linkedin_seats,
      connect_sessions, company_profiles, credit_ledger, webhook_events, job_requests,
      org_daily_summaries, rate_limit_buckets, suppressions, users, organizations,
      post_engagers, scraped_posts, profiles_cache, companies_cache, provider_runtime,
      worker_heartbeats
    RESTART IDENTITY CASCADE
  `;
}

export async function insertOrg(sql: Sql, name: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO organizations (name) VALUES (${name}) RETURNING id
  `;
  return rows[0]!.id;
}

export async function insertUser(sql: Sql, orgId: string, email: string, id = crypto.randomUUID()): Promise<string> {
  await sql`
    INSERT INTO users (id, org_id, email, role) VALUES (${id}, ${orgId}, ${email}, 'owner')
  `;
  return id;
}
