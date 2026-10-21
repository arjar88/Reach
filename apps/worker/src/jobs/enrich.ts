import { Worker, type ConnectionOptions } from "bullmq";
import { config } from "../../../../shared/config.js";
import type { Database } from "../../../../shared/db/client.js";
import { enrichContact } from "../../../../shared/inbox/enrich-run.js";
import { createEnrichment } from "../../../../shared/providers/enrichment.js";
import { createResend } from "../../../../shared/providers/resend.js";
import type { Sql } from "postgres";

export const ENRICH_QUEUE = "enrich";

export function startEnrichWorker(connection: ConnectionOptions, db: Database, sql: Sql): Worker {
  const enrichment = createEnrichment();
  const resend = process.env.RESEND_API_KEY ? createResend() : undefined;
  return new Worker(ENRICH_QUEUE, async (job) => {
    const contactId = typeof job.data?.contactId === "string" ? job.data.contactId : "";
    if (!contactId) throw new Error("Enrich job is missing a contact");
    await enrichContact(db, sql, contactId, { enrichment, resend });
  }, { connection, concurrency: config.queues.enrich });
}
