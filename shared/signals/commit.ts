import { and, eq, sql } from "drizzle-orm";
import { cleanFirstName } from "../names.js";
import { forOrg } from "../db/scope.js";
import { contacts, organizations, seenPeople, signals } from "../db/schema.js";
import type { Database } from "../db/client.js";
import type { CommitWrite, PipelinePerson } from "./pipeline.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface SignalTx {
  upsertContact(person: PipelinePerson, write: CommitWrite): Promise<void>;
  upsertSeen(profileUrl: string, score: number | null, write: CommitWrite): Promise<void>;
  appendSignal(profileUrl: string, detail: string, at: string, write: CommitWrite): Promise<void>;
  advanceCursor(write: CommitWrite): Promise<void>;
}

/** Contacts and seen rows, then the cursor. Call this inside one transaction. */
export async function applySignalWrites(tx: SignalTx, write: CommitWrite): Promise<void> {
  for (const person of write.contacts) await tx.upsertContact(person, write);
  for (const row of write.seen) await tx.upsertSeen(row.profileUrl, row.score, write);
  for (const row of write.appends) await tx.appendSignal(row.profileUrl, row.detail, row.at, write);
  await tx.advanceCursor(write);
}

function signalTag(signalKey: string, detail: string, at: string) {
  const type = signalKey.split(":")[0] ?? "keyword";
  return { type, detail, at };
}

export async function applySignalWritesDb(db: Database, write: CommitWrite, meta: { listId: string | null; agentId: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    await applySignalWrites(dbTx(tx, meta), write);
  });
}

function dbTx(tx: Tx, meta: { listId: string | null; agentId: string | null }): SignalTx {
  return {
    async upsertContact(person, write) {
      const tag = signalTag(write.signalKey, person.detail, person.scrapedAt);
      await tx.insert(contacts).values({
        orgId: write.orgId,
        listId: meta.listId,
        agentId: meta.agentId,
        profileUrl: person.profileUrl,
        providerId: null,
        name: person.name,
        firstNameClean: cleanFirstName(person.name),
        title: person.title,
        company: person.company,
        companyLinkedinId: person.companyLinkedinId,
        country: person.country,
        signals: [tag],
        fitScore: person.score,
        scoreReason: person.reason,
        status: person.status,
        emailStatus: "unknown",
      }).onConflictDoUpdate({
        target: [contacts.orgId, contacts.profileUrl],
        set: {
          fitScore: person.score,
          scoreReason: person.reason,
          title: person.title,
          company: person.company,
          signals: sql`coalesce(${contacts.signals}, '[]'::jsonb) || ${JSON.stringify([tag])}::jsonb`,
        },
      });
    },
    async upsertSeen(profileUrl, score, write) {
      await tx.insert(seenPeople).values({
        orgId: write.orgId,
        profileUrl,
        signalKey: write.signalKey,
        seenAt: new Date(),
        score,
      }).onConflictDoUpdate({
        target: [seenPeople.orgId, seenPeople.profileUrl, seenPeople.signalKey],
        set: { score, seenAt: new Date() },
      });
    },
    async appendSignal(profileUrl, detail, at, write) {
      const tag = signalTag(write.signalKey, detail, at);
      await tx.update(contacts).set({
        signals: sql`coalesce(${contacts.signals}, '[]'::jsonb) || ${JSON.stringify([tag])}::jsonb`,
      }).where(and(forOrg(write.orgId, contacts.orgId), eq(contacts.profileUrl, profileUrl)));
    },
    async advanceCursor(write) {
      await tx.update(signals).set({
        processedUntil: write.processedUntil ? new Date(write.processedUntil) : null,
        zeroResultRuns: write.newContactCount === 0 ? sql`${signals.zeroResultRuns} + 1` : 0,
      }).where(and(eq(signals.id, write.signalId), forOrg(write.orgId, signals.orgId)));
      await tx.update(organizations).set({
        scoredThisMonth: sql`${organizations.scoredThisMonth} + ${write.scoredCount}`,
      }).where(eq(organizations.id, write.orgId));
    },
  };
}
