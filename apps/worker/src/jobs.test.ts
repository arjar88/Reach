import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, contacts, jobRequests, signals } from "../../../shared/db/schema.js";
import { readJobForOrg } from "../../../shared/db/queries.js";
import { forOrg } from "../../../shared/db/scope.js";
import { insertOrg, resetTables, testDatabase } from "../../../shared/db/test-support.js";
import { signalKey } from "../../../shared/profiles.js";
import type { OnboardingOutput } from "../../../shared/prompts/schemas.js";
import type { JobDeps } from "./jobs/deps.js";
import { handlePreview, handleResolveNames, runHandledJob, type JobRow } from "./jobs/onboarding.js";
import { fanoutSignalIds } from "./fanout.js";

const model: OnboardingOutput = {
  company: { description: "Sells outbound software to founders.", pain_points: ["no replies"], features: ["sequences"] },
  icp: { job_titles: ["Founder"], industries: ["Software"], company_sizes: ["11-50"], locations: ["Israel"] },
  keywords: ["outbound"],
  competitor_names: ["ExampleCo"],
  influencer_names: ["Ada"],
};

function deps(overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    loadText: async () => ({ text: "x".repeat(600), thin: false }),
    analyze: async () => model,
    searchCompanies: async (name) => [{ name, logo: null, followers: 10, url: "https://www.linkedin.com/company/example", companyLinkedinId: "example" }],
    searchProfiles: async (name) => [{ name, headline: "Founder", url: "https://www.linkedin.com/in/ada", followers: 20 }],
    engagersFor: async () => [{
      profileUrl: "https://www.linkedin.com/in/ada",
      name: "Ada",
      headline: "Founder",
      isPerson: true,
      scrapedAt: new Date().toISOString(),
      detail: "outbound",
    }],
    prescore: async (_agent, people) => people.map((person) => ({ id: person.id, keep: true })),
    score: async () => JSON.stringify({ results: [{ id: "https://www.linkedin.com/in/ada", score: 0.9, reason: "Founder at a software company" }] }),
    ...overrides,
  };
}

describe("onboarding jobs", () => {
  let db: Awaited<ReturnType<typeof testDatabase>>["db"];
  let sql: Awaited<ReturnType<typeof testDatabase>>["sql"];

  beforeEach(async () => {
    ({ db, sql } = await testDatabase());
    await resetTables(sql);
  });

  afterAll(async () => {
    const conn = await testDatabase();
    await conn.sql.end({ timeout: 1 });
  });

  it("analyze saves a draft and does not ack", async () => {
    const orgId = await insertOrg(sql, "Analyze");
    const [job] = await db.insert(jobRequests).values({
      orgId,
      type: "analyze",
      payload: { website: "https://example.com" },
      status: "running",
    }).returning();
    if (!job) throw new Error("job missing");
    const row: JobRow = { id: job.id, orgId, type: "analyze", payload: job.payload };
    const handled = await runHandledJob(db, sql, row, deps());
    expect(handled).toBe(true);
    const saved = await readJobForOrg(db, orgId, job.id);
    expect({ status: saved?.status, error: saved?.error }).toEqual({ status: "done", error: null });
    expect(saved?.result).toMatchObject({ keywords: ["outbound"], agentId: expect.any(String) });
    expect(saved?.result).not.toMatchObject({ acked: true });
    const agentRows = await db.select().from(agents).where(forOrg(orgId, agents.orgId));
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]?.status).toBe("draft");
    const signalRows = await db.select().from(signals).where(forOrg(orgId, signals.orgId));
    expect(signalRows.map((item) => item.signalKey)).toEqual([signalKey("keyword", "outbound")]);
  });

  it("resolve_names returns candidates and writes no signals", async () => {
    const orgId = await insertOrg(sql, "Names");
    const result = await handleResolveNames({
      id: crypto.randomUUID(),
      orgId,
      type: "resolve_names",
      payload: { competitors: ["ExampleCo"], influencers: ["Ada"] },
    }, deps());
    expect(result.competitors[0]?.candidates).toHaveLength(1);
    expect(result.influencers[0]?.candidates[0]?.url).toContain("/in/ada");
    const signalRows = await db.select().from(signals);
    expect(signalRows).toHaveLength(0);
  });

  it("preview scores people and writes nothing", async () => {
    const orgId = await insertOrg(sql, "Preview");
    const [agent] = await db.insert(agents).values({
      orgId,
      status: "draft",
      jobTitles: ["Founder"],
      industries: ["Software"],
      companySizes: ["11-50"],
      locations: ["Israel"],
      mandatoryKeywords: ["outbound"],
      excludedCompanies: [],
      excludedNames: [],
    }).returning();
    if (!agent) throw new Error("agent missing");
    await db.insert(signals).values({
      orgId,
      agentId: agent.id,
      type: "keyword",
      value: "outbound",
      signalKey: signalKey("keyword", "outbound"),
      enabled: true,
    });
    const [job] = await db.insert(jobRequests).values({
      orgId,
      type: "preview",
      payload: { agentId: agent.id },
      status: "running",
    }).returning();
    if (!job) throw new Error("job missing");
    const before = await db.select().from(contacts).where(forOrg(orgId, contacts.orgId));
    const result = await handlePreview(db, {
      id: job.id,
      orgId,
      type: "preview",
      payload: { agentId: agent.id },
    }, deps());
    expect(result.people.map((person) => person.profileUrl)).toEqual(["https://www.linkedin.com/in/ada"]);
    const after = await db.select().from(contacts).where(forOrg(orgId, contacts.orgId));
    expect(after).toEqual(before);
    const [signal] = await db.select().from(signals).where(eq(signals.agentId, agent.id));
    expect(signal?.processedUntil).toBeNull();
    const otherOrg = await insertOrg(sql, "Other");
    expect(await readJobForOrg(db, otherOrg, job.id)).toBeNull();
    expect((await readJobForOrg(db, orgId, job.id))?.id).toBe(job.id);
  });

  it("fails the row when the model key is missing", async () => {
    const orgId = await insertOrg(sql, "Fail");
    const [job] = await db.insert(jobRequests).values({
      orgId,
      type: "analyze",
      payload: { description: "A long enough description of the product for analysis." },
      status: "running",
    }).returning();
    if (!job) throw new Error("job missing");
    await runHandledJob(db, sql, {
      id: job.id,
      orgId,
      type: "analyze",
      payload: job.payload,
    }, deps({ analyze: async () => { throw new Error("ANTHROPIC_API_KEY is not set"); } }));
    const saved = await readJobForOrg(db, orgId, job.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.error).toContain("ANTHROPIC_API_KEY");
    expect(saved?.result).toBeNull();
  });

  it("fans out every enabled signal on an active agent", () => {
    const rows = [
      { id: "1", signalKey: "keyword:a", enabled: true, agentStatus: "active" },
      { id: "2", signalKey: "keyword:a", enabled: false, agentStatus: "active" },
      { id: "3", signalKey: "keyword:a", enabled: true, agentStatus: "draft" },
      { id: "4", signalKey: "keyword:b", enabled: true, agentStatus: "active" },
    ];
    expect(fanoutSignalIds(rows, "keyword:a")).toEqual(["1"]);
  });
});
