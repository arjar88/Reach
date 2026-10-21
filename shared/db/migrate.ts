import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export async function migrate(databaseUrl = process.env.DATABASE_URL_SESSION): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL_SESSION is not set");
  const sql = postgres(databaseUrl, { max: 1, prepare: true });
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await sql<{ id: string }[]>`SELECT id FROM schema_migrations WHERE id = ${file}`;
      if (done.length) continue;
      const body = readFileSync(join(dir, file), "utf8");
      await sql.unsafe(body);
      await sql`INSERT INTO schema_migrations (id) VALUES (${file})`;
    }
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && process.argv[1].includes("migrate")) {
  migrate().then(() => {
    console.log("migrated");
    process.exit(0);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "migrate failed");
    process.exit(1);
  });
}
