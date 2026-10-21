"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { validateCampaign } from "../../../../../shared/campaigns.js";
import { forOrg } from "../../../../../shared/db/scope.js";
import { agents, campaignSteps, campaigns, companyProfiles, jobRequests, lists, signals } from "../../../../../shared/db/schema.js";
import type { SignalType } from "../../../../../shared/config.js";
import { signalKey } from "../../../../../shared/profiles.js";
import { requireOrg } from "../org.js";

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(/[\n,]/).map((part) => part.trim()).filter(Boolean);
}

async function enqueue(type: "analyze" | "resolve_names" | "preview", payload: Record<string, unknown>) {
  const { db, orgId } = await requireOrg();
  if (type === "preview") {
    const prior = await db.select().from(jobRequests).where(and(
      forOrg(orgId, jobRequests.orgId),
      eq(jobRequests.type, "preview"),
      eq(jobRequests.status, "done"),
    )).limit(1);
    if (prior[0]) return prior[0].id;
  }
  const [job] = await db.insert(jobRequests).values({ orgId, type, payload, status: "pending" }).returning({ id: jobRequests.id });
  if (!job) throw new Error("Could not queue the job");
  revalidatePath("/onboarding");
  return job.id;
}

export async function analyzeWebsite(formData: FormData) {
  const website = String(formData.get("website") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!website && description.length < 20) throw new Error("Enter a website or describe what you sell");
  await enqueue("analyze", website ? { website } : { description });
}

export async function saveOnboardingDraft(formData: FormData) {
  const { db, orgId } = await requireOrg();
  const keywords = lines(formData.get("keywords")).slice(0, 6);
  const profile = {
    website: String(formData.get("website") ?? "").trim() || null,
    description: String(formData.get("description") ?? "").trim() || null,
    painPoints: lines(formData.get("painPoints")),
    features: lines(formData.get("features")),
    ownCompanyLinkedinId: String(formData.get("ownCompany") ?? "").trim() || null,
  };
  const icp = {
    jobTitles: lines(formData.get("jobTitles")),
    industries: lines(formData.get("industries")),
    companySizes: lines(formData.get("companySizes")),
    locations: lines(formData.get("locations")),
    mandatoryKeywords: keywords,
    excludedCompanies: lines(formData.get("excludedCompanies")),
    excludedNames: lines(formData.get("excludedNames")),
    minScore: Number(formData.get("minScore") ?? 0.7) || 0.7,
    reviewMode: formData.get("reviewMode") !== "off",
  };
  await db.transaction(async (tx) => {
    const existingProfile = await tx.select().from(companyProfiles).where(forOrg(orgId, companyProfiles.orgId)).limit(1);
    if (existingProfile[0]) {
      await tx.update(companyProfiles).set(profile).where(forOrg(orgId, companyProfiles.orgId));
    } else {
      await tx.insert(companyProfiles).values({ orgId, ...profile });
    }
    const existingAgent = await tx.select().from(agents).where(forOrg(orgId, agents.orgId)).limit(1);
    const agentValues = { ...icp, status: existingAgent[0]?.status ?? "draft" };
    const agentId = existingAgent[0]?.id;
    const id = agentId ?? (await tx.insert(agents).values({ orgId, ...agentValues }).returning({ id: agents.id }))[0]?.id;
    if (!id) throw new Error("Could not save the agent");
    if (agentId) await tx.update(agents).set(agentValues).where(and(eq(agents.id, id), forOrg(orgId, agents.orgId)));
    await tx.delete(signals).where(and(forOrg(orgId, signals.orgId), eq(signals.agentId, id), eq(signals.type, "keyword")));
    if (keywords.length) {
      await tx.insert(signals).values(keywords.map((keyword) => ({
        orgId,
        agentId: id,
        type: "keyword",
        value: keyword,
        signalKey: signalKey("keyword", keyword),
        label: keyword,
        enabled: true,
      })));
    }
  });
  revalidatePath("/onboarding");
  revalidatePath("/agents");
}

export async function requestResolveNames(formData: FormData) {
  await enqueue("resolve_names", {
    competitors: lines(formData.get("competitors")).slice(0, 5),
    influencers: lines(formData.get("influencers")).slice(0, 5),
  });
}

export async function requestPreview() {
  const { db, orgId } = await requireOrg();
  const [agent] = await db.select().from(agents).where(forOrg(orgId, agents.orgId)).limit(1);
  if (!agent) throw new Error("Save an ICP before preview");
  const rows = await db.select().from(signals).where(and(forOrg(orgId, signals.orgId), eq(signals.agentId, agent.id), eq(signals.enabled, true)));
  if (rows.length === 0) throw new Error("Add a keyword, competitor, or influencer before preview");
  await enqueue("preview", { agentId: agent.id });
}

export async function confirmOnboarding(formData: FormData) {
  const { db, orgId } = await requireOrg();
  const competitors = lines(formData.get("competitorPages"));
  const influencers = lines(formData.get("influencerPages"));
  const excludedCompanies = lines(formData.get("excludedCompanies"));
  const excludedNames = lines(formData.get("excludedNames"));
  const steps = [
    { position: 1, type: "visit" as const, delayDays: 0, mode: "ai" as const, template: null, subject: null },
    { position: 2, type: "invite" as const, delayDays: 1, mode: "ai" as const, template: null, subject: null },
    { position: 3, type: "message" as const, delayDays: 2, mode: "ai" as const, template: null, subject: null },
    { position: 4, type: "message" as const, delayDays: 4, mode: "ai" as const, template: null, subject: null },
  ];
  const check = validateCampaign({ linkedinSeatId: null, emailSeatId: null, steps }, "save");
  if (!check.ok) throw new Error(check.errors.join("; "));
  await db.transaction(async (tx) => {
    const [agent] = await tx.select().from(agents).where(forOrg(orgId, agents.orgId)).limit(1);
    if (!agent) throw new Error("Save an ICP before confirming");
    const [list] = await tx.insert(lists).values({ orgId, name: "Onboarding list" }).returning({ id: lists.id });
    if (!list) throw new Error("Could not create the list");
    const [campaign] = await tx.insert(campaigns).values({
      orgId,
      listId: list.id,
      name: "First campaign",
      linkedinSeatId: null,
      emailSeatId: null,
      active: false,
      hasContacts: false,
    }).returning({ id: campaigns.id });
    if (!campaign) throw new Error("Could not create the campaign");
    await tx.insert(campaignSteps).values(steps.map((step) => ({ ...step, orgId, campaignId: campaign.id })));
    await tx.update(agents).set({
      status: "active",
      listId: list.id,
      excludedCompanies,
      excludedNames,
    }).where(and(eq(agents.id, agent.id), forOrg(orgId, agents.orgId)));
    const extra = [
      ...competitors.map((value) => ({ type: "company_page" as SignalType, value })),
      ...influencers.map((value) => ({ type: "influencer" as SignalType, value })),
    ];
    if (extra.length) {
      await tx.insert(signals).values(extra.map((row) => ({
        orgId,
        agentId: agent.id,
        type: row.type,
        value: row.value,
        signalKey: signalKey(row.type, row.value),
        label: row.value,
        enabled: true,
      })));
    }
  });
  revalidatePath("/onboarding");
  revalidatePath("/agents");
  revalidatePath("/campaigns");
}

export async function latestJobs() {
  const { db, orgId } = await requireOrg();
  return db.select().from(jobRequests).where(forOrg(orgId, jobRequests.orgId)).orderBy(desc(jobRequests.createdAt)).limit(6);
}
