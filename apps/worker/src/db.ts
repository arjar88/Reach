import { createDb } from "../../../shared/db/client.js";

type Database = ReturnType<typeof createDb>;

let cached: Database | null = null;

/** Main boot passes the single worker pool so ticks do not open a second one. */
export function useDatabase(existing: Database): void {
  cached = existing;
}

export function database(): Database {
  if (cached) return cached;
  const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL_POOLED;
  if (!url) throw new Error("DATABASE_URL_SESSION is not set");
  cached = createDb(url, "worker");
  return cached;
}
