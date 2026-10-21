import type { Sql } from "postgres";

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export interface ClaimedJob {
  id: string;
  org_id: string;
  type: string;
}

export async function claimJobRequests(sql: Sql, limit = 500): Promise<ClaimedJob[]> {
  return sql.begin(async (tx) => {
    return tx<ClaimedJob[]>`
      WITH picked AS (
        SELECT id FROM job_requests
        WHERE status = 'pending'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE job_requests AS j
      SET status = 'running', updated_at = now()
      FROM picked
      WHERE j.id = picked.id
      RETURNING j.id, j.org_id, j.type
    `;
  });
}

/** Types with no handler yet are acknowledged. analyze, resolve_names, and preview store their own result. */
export async function completeJobRequest(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE job_requests
    SET status = 'done',
        processed_at = now(),
        result = '{"acked":true}'::jsonb,
        updated_at = now()
    WHERE id = ${id} AND status = 'running'
    RETURNING id
  `;
  return rows.length > 0;
}

export async function finishJobRequest(sql: Sql, id: string, result: unknown): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE job_requests
    SET status = 'done',
        processed_at = now(),
        result = ${jsonText(result)}::jsonb,
        error = null,
        updated_at = now()
    WHERE id = ${id} AND status = 'running'
    RETURNING id
  `;
  return rows.length > 0;
}

export async function failJobRequest(sql: Sql, id: string, error: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE job_requests
    SET status = 'failed',
        processed_at = now(),
        error = ${error.slice(0, 500)},
        updated_at = now()
    WHERE id = ${id} AND status = 'running'
    RETURNING id
  `;
  return rows.length > 0;
}

export async function loadRunningJob(sql: Sql, id: string): Promise<(ClaimedJob & { payload: unknown }) | null> {
  const rows = await sql<(ClaimedJob & { payload: unknown })[]>`
    SELECT id, org_id, type, payload
    FROM job_requests
    WHERE id = ${id} AND status = 'running'
  `;
  return rows[0] ?? null;
}

export async function releaseJobRequest(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE job_requests
    SET status = 'pending', updated_at = now()
    WHERE id = ${id} AND status = 'running'
  `;
}

export async function touchHeartbeat(sql: Sql, detail: Record<string, unknown> = {}): Promise<void> {
  await sql`
    INSERT INTO worker_heartbeats (id, last_seen_at, detail)
    VALUES ('primary', now(), ${jsonText(detail)}::jsonb)
    ON CONFLICT (id) DO UPDATE
    SET last_seen_at = now(), detail = EXCLUDED.detail, updated_at = now()
  `;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const normalized = value.includes("T") ? value : value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function readHeartbeat(sql: Sql): Promise<Date | null> {
  const rows = await sql<{ last_seen_at: Date | string }[]>`
    SELECT last_seen_at FROM worker_heartbeats WHERE id = 'primary'
  `;
  return asDate(rows[0]?.last_seen_at);
}
