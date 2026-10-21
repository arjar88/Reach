import type { Sql } from "postgres";

/**
 * One planned action per seat. Seat rows are locked SKIP LOCKED so two workers
 * cannot claim two actions for the same seat. A seat that already has sending
 * or unknown work is left alone (one action at a time).
 */
export async function claimDueActions(sql: Sql): Promise<string[]> {
  return sql.begin(async (tx) => {
    const linkedin = await tx<{ id: string }[]>`
      WITH locked AS (
        SELECT id FROM linkedin_seats
        WHERE unipile_status = 'OK' AND paused_reason IS NULL
        FOR UPDATE SKIP LOCKED
      ),
      picked AS (
        SELECT DISTINCT ON (a.linkedin_seat_id) a.id
        FROM actions a
        JOIN locked l ON l.id = a.linkedin_seat_id
        WHERE a.status = 'planned'
          AND a.scheduled_for <= now()
          AND NOT EXISTS (
            SELECT 1 FROM actions o
            WHERE o.linkedin_seat_id = a.linkedin_seat_id
              AND o.status IN ('sending', 'unknown')
          )
        ORDER BY a.linkedin_seat_id, a.scheduled_for
      )
      UPDATE actions
      SET status = 'sending', claimed_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM picked)
      RETURNING id
    `;
    const email = await tx<{ id: string }[]>`
      WITH locked AS (
        SELECT id FROM email_seats
        WHERE unipile_status = 'OK' AND paused_reason IS NULL
        FOR UPDATE SKIP LOCKED
      ),
      picked AS (
        SELECT DISTINCT ON (a.email_seat_id) a.id
        FROM actions a
        JOIN locked l ON l.id = a.email_seat_id
        WHERE a.status = 'planned'
          AND a.scheduled_for <= now()
          AND NOT EXISTS (
            SELECT 1 FROM actions o
            WHERE o.email_seat_id = a.email_seat_id
              AND o.status IN ('sending', 'unknown')
          )
        ORDER BY a.email_seat_id, a.scheduled_for
      )
      UPDATE actions
      SET status = 'sending', claimed_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM picked)
      RETURNING id
    `;
    return [...linkedin, ...email].map((row) => row.id);
  });
}
