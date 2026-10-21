import type { Sql } from "postgres";

/** Postgres counter. The web app has no Redis. */
export async function hitRateLimit(sql: Sql, key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; count: number }> {
  const rows = await sql<{ count: number }[]>`
    INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
    VALUES (${key}, now(), 1)
    ON CONFLICT (bucket_key) DO UPDATE SET
      count = CASE
        WHEN rate_limit_buckets.window_start < now() - make_interval(secs => ${windowSec}) THEN 1
        ELSE rate_limit_buckets.count + 1
      END,
      window_start = CASE
        WHEN rate_limit_buckets.window_start < now() - make_interval(secs => ${windowSec}) THEN now()
        ELSE rate_limit_buckets.window_start
      END
    RETURNING count
  `;
  const count = rows[0]?.count ?? limit + 1;
  return { allowed: count <= limit, count };
}
