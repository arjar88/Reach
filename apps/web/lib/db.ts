import { createDb } from "@reach/shared";

type WebDb = ReturnType<typeof createDb>;

const globalForDb = globalThis as { __reachWeb?: WebDb };

export function getDb() {
  const url = process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL_SESSION;
  if (!url) throw new Error("DATABASE_URL_POOLED is not set");
  globalForDb.__reachWeb ??= createDb(url, "web");
  return globalForDb.__reachWeb;
}

/** Sender screens and account actions use this name. */
export function database() {
  return getDb();
}
