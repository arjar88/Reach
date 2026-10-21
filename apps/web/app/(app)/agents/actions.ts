"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { SignalType } from "../../../../../shared/config.js";
import { forOrg } from "../../../../../shared/db/scope.js";
import { agents, signals } from "../../../../../shared/db/schema.js";
import { signalKey } from "../../../../../shared/profiles.js";
import { requireOrg } from "../org.js";

const SIGNAL_TYPES = new Set<SignalType>(["keyword", "company_page", "influencer"]);

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(/[\n,]/).map((part) => part.trim()).filter(Boolean);
}

function asSignalType(value: string): SignalType {
  if (value === "profile_viewers") throw new Error("Profile viewers are not part of this build");
  if (!SIGNAL_TYPES.has(value as SignalType)) throw new Error("Signal type must be keyword, company page, or influencer");
  return value as SignalType;
}

export async function updateAgent(formData: FormData) {
  const agentId = String(formData.get("agentId") ?? "");
  const { db, orgId } = await requireOrg();
  const keywords = lines(formData.get("keywords")).slice(0, 6);
  const values = {
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
    const updated = await tx.update(agents).set(values).where(and(eq(agents.id, agentId), forOrg(orgId, agents.orgId))).returning({ id: agents.id });
    if (!updated[0]) throw new Error("Agent not found");
    await tx.delete(signals).where(and(forOrg(orgId, signals.orgId), eq(signals.agentId, agentId), eq(signals.type, "keyword")));
    if (keywords.length) {
      await tx.insert(signals).values(keywords.map((keyword) => ({
        orgId,
        agentId,
        type: "keyword",
        value: keyword,
        signalKey: signalKey("keyword", keyword),
        label: keyword,
        enabled: true,
      })));
    }
  });
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
}

export async function upsertSignal(formData: FormData) {
  const agentId = String(formData.get("agentId") ?? "");
  const type = asSignalType(String(formData.get("type") ?? ""));
  const value = String(formData.get("value") ?? "").trim();
  if (!value) throw new Error("Enter a signal value");
  const key = signalKey(type, value);
  const { db, orgId } = await requireOrg();
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), forOrg(orgId, agents.orgId))).limit(1);
  if (!agent) throw new Error("Agent not found");
  const [existing] = await db.select().from(signals).where(and(
    forOrg(orgId, signals.orgId),
    eq(signals.agentId, agentId),
    eq(signals.signalKey, key),
  )).limit(1);
  if (existing) {
    await db.update(signals).set({ type, value, label: value, enabled: true }).where(and(eq(signals.id, existing.id), forOrg(orgId, signals.orgId)));
  } else {
    await db.insert(signals).values({ orgId, agentId, type, value, signalKey: key, label: value, enabled: true });
  }
  revalidatePath(`/agents/${agentId}`);
}

export async function toggleSignal(formData: FormData) {
  const signalId = String(formData.get("signalId") ?? "");
  const { db, orgId } = await requireOrg();
  const [row] = await db.select().from(signals).where(and(eq(signals.id, signalId), forOrg(orgId, signals.orgId))).limit(1);
  if (!row) throw new Error("Signal not found");
  if (row.type === "profile_viewers") throw new Error("Profile viewers are not part of this build");
  await db.update(signals).set({ enabled: !row.enabled }).where(and(eq(signals.id, signalId), forOrg(orgId, signals.orgId)));
  revalidatePath(`/agents/${row.agentId}`);
}
