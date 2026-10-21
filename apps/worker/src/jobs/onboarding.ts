import { and, eq } from "drizzle-orm";
import { config } from "../../../../shared/config.js";
import { signalKey } from "../../../../shared/profiles.js";
import type { Database } from "../../../../shared/db/client.js";
import { forOrg, suppressionsFor } from "../../../../shared/db/scope.js";
import {
  agents,
  companyProfiles,
  contacts,
  seenPeople,
  signals,
  suppressions,
} from "../../../../shared/db/schema.js";
import {
  failJobRequest,
  finishJobRequest,
  loadRunningJob,
  type ClaimedJob,
} from "../../../../shared/db/outbox.js";
import type { Sql } from "postgres";
import type { OnboardingOutput } from "../../../../shared/prompts/schemas.js";
import { runSignalPipeline, type AgentFilter, type SignalRead } from "../../../../shared/signals/pipeline.js";
import type { JobDeps } from "./deps.js";

export interface JobRow {
  id: string;
  orgId: string;
  type: string;
  payload: unknown;
}

const HANDLED = new Set(["analyze", "resolve_names", "preview"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function names(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function asFilter(agent: typeof agents.$inferSelect): AgentFilter {
  return {
    minScore: agent.minScore,
    reviewMode: agent.reviewMode,
    mandatoryKeywords: agent.mandatoryKeywords,
    excludedCompanies: agent.excludedCompanies,
    excludedNames: agent.excludedNames,
    jobTitles: agent.jobTitles,
    industries: agent.industries,
    companySizes: agent.companySizes,
    locations: agent.locations,
  };
}

export async function handleAnalyze(db: Database, job: JobRow, deps: JobDeps): Promise<OnboardingOutput & { agentId: string }> {
  const payload = record(job.payload);
  const website = text(payload.website);
  const description = text(payload.description);
  let source = description;
  if (website) {
    const loaded = await deps.loadText(website);
    if (loaded.thin) throw new Error("Describe what you sell and who buys it");
    source = loaded.text;
  } else if (description.length < 20) {
    throw new Error("Enter a website or describe what you sell");
  }
  const model = await deps.analyze(source);
  const keywords = model.keywords.slice(0, 6);
  const agentId = await db.transaction(async (tx) => {
    const profile = {
      website: website || null,
      description: model.company.description,
      painPoints: model.company.pain_points,
      features: model.company.features,
    };
    const existingProfile = await tx.select({ id: companyProfiles.id }).from(companyProfiles).where(forOrg(job.orgId, companyProfiles.orgId)).limit(1);
    if (existingProfile[0]) {
      await tx.update(companyProfiles).set(profile).where(forOrg(job.orgId, companyProfiles.orgId));
    } else {
      await tx.insert(companyProfiles).values({ orgId: job.orgId, ...profile });
    }
    const icp = {
      jobTitles: model.icp.job_titles,
      industries: model.icp.industries,
      companySizes: model.icp.company_sizes,
      locations: model.icp.locations,
      mandatoryKeywords: keywords,
    };
    const existingAgent = await tx.select().from(agents).where(forOrg(job.orgId, agents.orgId)).limit(1);
    const id = existingAgent[0]?.id ?? (await tx.insert(agents).values({
      orgId: job.orgId,
      status: "draft",
      ...icp,
      excludedCompanies: [],
      excludedNames: [],
    }).returning({ id: agents.id }))[0]?.id;
    if (!id) throw new Error("Could not save the draft agent");
    if (existingAgent[0]) {
      await tx.update(agents).set(icp).where(and(eq(agents.id, id), forOrg(job.orgId, agents.orgId)));
    }
    await tx.delete(signals).where(and(forOrg(job.orgId, signals.orgId), eq(signals.agentId, id), eq(signals.type, "keyword")));
    if (keywords.length) {
      await tx.insert(signals).values(keywords.map((keyword) => ({
        orgId: job.orgId,
        agentId: id,
        type: "keyword",
        value: keyword,
        signalKey: signalKey("keyword", keyword),
        label: keyword,
        enabled: true,
      })));
    }
    return id;
  });
  return { ...model, agentId };
}

export async function handleResolveNames(job: JobRow, deps: JobDeps) {
  const payload = record(job.payload);
  const competitors = names(payload.competitors, 5);
  const influencers = names(payload.influencers, 5);
  const companyCandidates = [];
  for (const name of competitors) {
    const candidates = (await deps.searchCompanies(name)).slice(0, 3);
    companyCandidates.push({ query: name, candidates });
  }
  const profileCandidates = [];
  for (const name of influencers) {
    const candidates = (await deps.searchProfiles(name)).slice(0, 3);
    profileCandidates.push({ query: name, candidates });
  }
  return { competitors: companyCandidates, influencers: profileCandidates };
}

export async function handlePreview(db: Database, job: JobRow, deps: JobDeps, now = new Date()) {
  const agentId = text(record(job.payload).agentId);
  if (!agentId) throw new Error("Save an ICP before preview");
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), forOrg(job.orgId, agents.orgId))).limit(1);
  if (!agent) throw new Error("Save an ICP before preview");
  const watched = await db.select().from(signals).where(and(
    forOrg(job.orgId, signals.orgId),
    eq(signals.agentId, agent.id),
    eq(signals.enabled, true),
  ));
  if (watched.length === 0) throw new Error("Add a keyword, competitor, or influencer before preview");
  const filter = asFilter(agent);
  const people = [];
  const dropped = [];
  for (const signal of watched) {
    const engagers = await deps.engagersFor({ value: signal.value, signalKey: signal.signalKey }, now);
    const read: SignalRead = {
      async existing(profileUrl) {
        const rows = await db.select({ id: contacts.id }).from(contacts).where(and(
          forOrg(job.orgId, contacts.orgId),
          eq(contacts.profileUrl, profileUrl),
        )).limit(1);
        return rows.length > 0;
      },
      async seen(profileUrl) {
        const rows = await db.select({ profileUrl: seenPeople.profileUrl }).from(seenPeople).where(and(
          forOrg(job.orgId, seenPeople.orgId),
          eq(seenPeople.profileUrl, profileUrl),
          eq(seenPeople.signalKey, signal.signalKey),
        )).limit(1);
        return rows.length > 0;
      },
      async suppressed(profileUrl) {
        const rows = await db.select({ id: suppressions.id }).from(suppressions).where(and(
          suppressionsFor(job.orgId),
          eq(suppressions.profileUrl, profileUrl),
        )).limit(1);
        return rows.length > 0;
      },
    };
    const result = await runSignalPipeline({
      mode: "preview",
      orgId: job.orgId,
      signalId: signal.id,
      signalKey: signal.signalKey,
      signalType: signal.type,
      agent: filter,
      engagers,
      now,
      read,
      prescore: (batch) => deps.prescore(filter, batch),
      score: (ids) => deps.score(filter, engagers, ids),
    });
    if (result.write) throw new Error("Preview tried to write");
    people.push(...result.people);
    dropped.push(...result.dropped);
  }
  people.sort((a, b) => b.score - a.score);
  return {
    people: people.slice(0, config.scoring.previewLimit),
    dropped,
  };
}

export function jobFromClaim(row: ClaimedJob & { payload: unknown }): JobRow {
  return { id: row.id, orgId: row.org_id, type: row.type, payload: row.payload ?? {} };
}

/** Runs analyze, resolve_names, and preview. Other types are acknowledged by the caller. */
export async function runHandledJob(db: Database, sql: Sql, job: JobRow, deps: JobDeps): Promise<boolean> {
  if (!HANDLED.has(job.type)) return false;
  try {
    const result = job.type === "analyze"
      ? await handleAnalyze(db, job, deps)
      : job.type === "resolve_names"
        ? await handleResolveNames(job, deps)
        : await handlePreview(db, job, deps);
    await finishJobRequest(sql, job.id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "job failed";
    await failJobRequest(sql, job.id, message);
  }
  return true;
}

export async function runClaimedJob(db: Database, sql: Sql, id: string, deps: JobDeps): Promise<void> {
  const row = await loadRunningJob(sql, id);
  if (!row) return;
  const job = jobFromClaim(row);
  const handled = await runHandledJob(db, sql, job, deps);
  if (!handled) {
    const { completeJobRequest } = await import("../../../../shared/db/outbox.js");
    await completeJobRequest(sql, job.id);
  }
}
