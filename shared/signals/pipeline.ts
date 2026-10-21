import { config } from "../config.js";
import { headlineHasExcludedName, isFreelancerOrOpenToWork, keywordBump } from "../headlines.js";
import { routeScore } from "../sequence.js";
import { resolveScores } from "./scoring.js";

export interface EngagerInput {
  profileUrl: string;
  name: string;
  headline: string;
  title?: string | null;
  company?: string | null;
  companyLinkedinId?: string | null;
  location?: string | null;
  country?: string | null;
  isPerson: boolean;
  scrapedAt: string;
  /** Page name, post id, or keyword. Never comment text. */
  detail: string;
}

export interface AgentFilter {
  minScore: number;
  reviewMode: boolean;
  mandatoryKeywords: string[];
  excludedCompanies: string[];
  excludedNames: string[];
  jobTitles: string[];
  industries: string[];
  companySizes: string[];
  locations: string[];
}

export interface PipelinePerson {
  profileUrl: string;
  name: string;
  headline: string;
  title: string | null;
  company: string | null;
  companyLinkedinId: string | null;
  country: string | null;
  score: number;
  reason: string;
  status: "pending_review" | "approved";
  detail: string;
  scrapedAt: string;
}

export interface CommitWrite {
  signalId: string;
  orgId: string;
  signalKey: string;
  processedUntil: string | null;
  scoredCount: number;
  contacts: PipelinePerson[];
  seen: { profileUrl: string; score: number | null }[];
  appends: { profileUrl: string; detail: string; at: string }[];
  newContactCount: number;
}

export interface SignalRead {
  existing(profileUrl: string): Promise<boolean>;
  seen(profileUrl: string): Promise<boolean>;
  suppressed(profileUrl: string): Promise<boolean>;
}

export interface PipelineResult {
  mode: "preview" | "commit";
  people: PipelinePerson[];
  dropped: { profileUrl: string; reason: string }[];
  write: CommitWrite | null;
  stopped?: "cap";
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

export async function runSignalPipeline(opts: {
  mode: "preview" | "commit";
  orgId: string;
  signalId: string;
  signalKey: string;
  signalType: string;
  agent: AgentFilter;
  engagers: EngagerInput[];
  now: Date;
  read: SignalRead;
  prescore: (people: { id: string; name: string; headline: string }[]) => Promise<{ id: string; keep: boolean }[]>;
  score: (ids: string[]) => Promise<string>;
  cap?: { scoredThisMonth: number; limit: number };
  rejections?: string[];
}): Promise<PipelineResult> {
  const dropped: { profileUrl: string; reason: string }[] = [];
  const appends: CommitWrite["appends"] = [];
  const candidates: EngagerInput[] = [];
  const excludedCompanies = new Set(opts.agent.excludedCompanies.map((c) => c.toLowerCase()));

  for (const person of opts.engagers) {
    if (!person.isPerson) {
      dropped.push({ profileUrl: person.profileUrl, reason: "not_person" });
      continue;
    }
    if (await opts.read.suppressed(person.profileUrl)) {
      dropped.push({ profileUrl: person.profileUrl, reason: "suppressed" });
      continue;
    }
    if (await opts.read.existing(person.profileUrl)) {
      if (opts.mode === "commit") {
        appends.push({ profileUrl: person.profileUrl, detail: person.detail, at: person.scrapedAt });
      }
      dropped.push({ profileUrl: person.profileUrl, reason: "existing" });
      continue;
    }
    if (await opts.read.seen(person.profileUrl)) {
      dropped.push({ profileUrl: person.profileUrl, reason: "seen" });
      continue;
    }
    if (person.companyLinkedinId && excludedCompanies.has(person.companyLinkedinId.toLowerCase())) {
      dropped.push({ profileUrl: person.profileUrl, reason: "excluded_company" });
      continue;
    }
    if (headlineHasExcludedName(person.headline, opts.agent.excludedNames)) {
      dropped.push({ profileUrl: person.profileUrl, reason: "excluded_name" });
      continue;
    }
    if (isFreelancerOrOpenToWork(person.headline)) {
      dropped.push({ profileUrl: person.profileUrl, reason: "freelancer" });
      continue;
    }
    candidates.push(person);
  }

  const kept: EngagerInput[] = [];
  for (let i = 0; i < candidates.length; i += config.scoring.batchSize) {
    const batch = candidates.slice(i, i + config.scoring.batchSize);
    const decision = await opts.prescore(batch.map((p) => ({ id: p.profileUrl, name: p.name, headline: p.headline })));
    const yes = new Set(decision.filter((d) => d.keep).map((d) => d.id));
    for (const person of batch) {
      if (!yes.has(person.profileUrl)) dropped.push({ profileUrl: person.profileUrl, reason: "prescore" });
      else kept.push(person);
    }
  }

  if (opts.mode === "commit" && opts.cap && opts.cap.scoredThisMonth >= opts.cap.limit) {
    return { mode: opts.mode, people: [], dropped, write: null, stopped: "cap" };
  }
  const room = opts.mode === "commit" && opts.cap ? Math.max(0, opts.cap.limit - opts.cap.scoredThisMonth) : kept.length;
  const toScore = kept.slice(0, room);

  const resolved = toScore.length
    ? await resolveScores(toScore.map((p) => ({ id: p.profileUrl })), opts.score)
    : { scored: new Map(), unscored: [] as string[], ignoredUnknown: [] as string[] };

  const byUrl = new Map(toScore.map((p) => [p.profileUrl, p]));
  const people: PipelinePerson[] = [];
  const seen: CommitWrite["seen"] = [];

  for (const [id, row] of resolved.scored) {
    const person = byUrl.get(id);
    if (!person) continue;
    const bumped = clampScore(row.score + keywordBump(`${person.headline} ${person.title ?? ""}`, opts.agent.mandatoryKeywords, config.scoring.keywordBump));
    const route = routeScore({ score: bumped, minScore: opts.agent.minScore, reviewMode: opts.agent.reviewMode, signalKey: opts.signalKey });
    if (route.kind === "seen") {
      seen.push({ profileUrl: id, score: bumped });
      dropped.push({ profileUrl: id, reason: "below_min" });
      continue;
    }
    people.push({
      profileUrl: person.profileUrl,
      name: person.name,
      headline: person.headline,
      title: person.title ?? null,
      company: person.company ?? null,
      companyLinkedinId: person.companyLinkedinId ?? null,
      country: person.country ?? null,
      score: bumped,
      reason: row.reason,
      status: route.status,
      detail: person.detail,
      scrapedAt: person.scrapedAt,
    });
  }
  for (const id of resolved.unscored) seen.push({ profileUrl: id, score: null });

  people.sort((a, b) => b.score - a.score);
  const previewPeople = people.slice(0, config.scoring.previewLimit);
  const scrapedTimes = opts.engagers.map((e) => Date.parse(e.scrapedAt)).filter((n) => !Number.isNaN(n));
  const processedUntil = scrapedTimes.length ? new Date(Math.max(...scrapedTimes)).toISOString() : null;
  if (opts.mode === "preview") {
    return { mode: "preview", people: previewPeople, dropped, write: null };
  }
  return {
    mode: "commit",
    people,
    dropped,
    write: {
      signalId: opts.signalId,
      orgId: opts.orgId,
      signalKey: opts.signalKey,
      processedUntil,
      scoredCount: resolved.scored.size + resolved.unscored.length,
      contacts: people,
      seen,
      appends,
      newContactCount: people.length,
    },
  };
}
