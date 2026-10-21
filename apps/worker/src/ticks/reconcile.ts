import { createUnipile } from "../../../../shared/providers/unipile.js";
import { runReconcile } from "../../../../shared/sender/persist.js";
import { database } from "../db.js";

/**
 * Mark crashed sends unknown and overdue plans ready.
 * Matching a vendor row updates the same action. This tick never calls invite or send.
 */
export async function reconcileTick(): Promise<{ unknown: number; released: number; sent: number }> {
  return runReconcile(database().sql, createUnipile());
}
