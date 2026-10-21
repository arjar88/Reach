import { describe, expect, it } from "vitest";
import { onboardingSchema, scoreSchema } from "./prompts/schemas.js";
import { runSignalPipeline, type AgentFilter, type EngagerInput } from "./signals/pipeline.js";
import { parseModelJson, resolveScores } from "./signals/scoring.js";

const agent: AgentFilter = {
  minScore: 0.7,
  reviewMode: false,
  mandatoryKeywords: [],
  excludedCompanies: [],
  excludedNames: [],
  jobTitles: [],
  industries: [],
  companySizes: [],
  locations: [],
};

function person(id: string): EngagerInput {
  return {
    profileUrl: id,
    name: "Ada Lovelace",
    headline: "VP Sales",
    isPerson: true,
    scrapedAt: "2026-10-21T12:00:00.000Z",
    detail: "pricing",
  };
}

describe("scoring", () => {
  it("rejects a score payload that does not match the schema", () => {
    expect(() => parseModelJson('{"results":[{"id":"a","score":2,"reason":"too high"}]}', scoreSchema)).toThrow(/JSON|score|too big|Number/i);
    expect(() => parseModelJson("nope", scoreSchema)).toThrow(/JSON/);
    const long = "x".repeat(141);
    expect(() => parseModelJson(JSON.stringify({ results: [{ id: "a", score: 0.5, reason: long }] }), scoreSchema)).toThrow();
    const onboarding = parseModelJson(JSON.stringify({
      company: { description: "Sells seats", pain_points: ["slow outreach"], features: ["signals"] },
      icp: { job_titles: ["VP"], industries: ["software"], company_sizes: ["11-50"], locations: ["US"] },
      keywords: ["pricing"],
      competitor_names: ["Acme"],
      influencer_names: ["Ada"],
    }), onboardingSchema);
    expect(onboarding.keywords).toEqual(["pricing"]);
  });

  it("ignores unknown ids and retries missing ids once", async () => {
    const asked: string[][] = [];
    const resolved = await resolveScores(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      async (ids) => {
        asked.push(ids);
        if (asked.length === 1) {
          return JSON.stringify({
            results: [
              { id: "a", score: 0.9, reason: "fits the ICP" },
              { id: "not-in-batch", score: 0.1, reason: "ignore me" },
            ],
          });
        }
        return JSON.stringify({ results: [{ id: "b", score: 0.8, reason: "second pass" }] });
      },
    );
    expect(asked).toEqual([["a", "b", "c"], ["b", "c"]]);
    expect(resolved.ignoredUnknown).toEqual(["not-in-batch"]);
    expect(resolved.scored.get("a")?.score).toBe(0.9);
    expect(resolved.scored.get("b")?.reason).toBe("second pass");
    expect(resolved.unscored).toEqual(["c"]);
  });

  it("saves a still-missing id as unscored seen_people and does not create a contact", async () => {
    const result = await runSignalPipeline({
      mode: "commit",
      orgId: "org",
      signalId: "sig",
      signalKey: "keyword:pricing",
      signalType: "keyword",
      agent,
      engagers: [person("https://www.linkedin.com/in/missing")],
      now: new Date("2026-10-21T12:00:00.000Z"),
      read: { existing: async () => false, seen: async () => false, suppressed: async () => false },
      prescore: async (people) => people.map((p) => ({ id: p.id, keep: true })),
      score: async () => JSON.stringify({ results: [] }),
    });
    expect(result.write?.contacts).toEqual([]);
    expect(result.write?.seen).toEqual([{ profileUrl: "https://www.linkedin.com/in/missing", score: null }]);
  });

  it("retries once when the model returns invalid JSON", async () => {
    let calls = 0;
    const resolved = await resolveScores([{ id: "a" }], async () => {
      calls += 1;
      if (calls === 1) return "not json";
      return JSON.stringify({ results: [{ id: "a", score: 0.4, reason: "weak" }] });
    });
    expect(calls).toBe(2);
    expect(resolved.scored.get("a")?.score).toBe(0.4);
  });
});
