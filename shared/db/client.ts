import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { config } from "../config.js";
import { schema } from "./schema.js";

export function poolConfig(role: "web" | "worker") {
  if (role === "web") return { max: 10, prepare: false as const };
  if (config.workerPoolMax !== 8) throw new Error("Worker pool max must stay 8");
  return { max: config.workerPoolMax, prepare: true as const };
}

export type Database = PostgresJsDatabase<typeof schema>;

export function createDb(url: string, role: "web" | "worker"): { db: Database; sql: Sql } {
  const sql = postgres(url, poolConfig(role));
  const db = drizzle(sql, { schema });
  return { db, sql };
}
