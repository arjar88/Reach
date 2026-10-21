import { fetchWebsite } from "../../../../shared/safe-fetch.js";
import { createApify, type CompanyCandidate, type ProfileCandidate } from "../../../../shared/providers/apify.js";
import { createClaude } from "../../../../shared/providers/claude.js";
import { onboardingPrompt, prescorePrompt, scorePrompt } from "../../../../shared/prompts/index.js";
import { onboardingSchema, prescoreSchema, type OnboardingOutput } from "../../../../shared/prompts/schemas.js";
import type { AgentFilter, EngagerInput } from "../../../../shared/signals/pipeline.js";
import { engagersFromApify } from "./scrape.js";

export interface LoadedText {
  text: string;
  thin: boolean;
}

export interface JobDeps {
  loadText(website: string): Promise<LoadedText>;
  analyze(text: string): Promise<OnboardingOutput>;
  searchCompanies(name: string): Promise<CompanyCandidate[]>;
  searchProfiles(name: string): Promise<ProfileCandidate[]>;
  engagersFor(signal: { value: string; signalKey: string }, now: Date): Promise<EngagerInput[]>;
  prescore(agent: AgentFilter, people: { id: string; name: string; headline: string }[]): Promise<{ id: string; keep: boolean }[]>;
  score(agent: AgentFilter, people: EngagerInput[], ids: string[]): Promise<string>;
}

export function liveJobDeps(): JobDeps {
  const claude = createClaude();
  const apify = createApify();
  return {
    async loadText(website) {
      const page = await fetchWebsite(website);
      return { text: page.text, thin: page.thin };
    },
    async analyze(text) {
      const prompt = onboardingPrompt({ text });
      return claude.json("strong", prompt.system, prompt.user, onboardingSchema);
    },
    searchCompanies: (name) => apify.searchCompanies(name),
    searchProfiles: (name) => apify.searchProfiles(name),
    engagersFor: (signal, now) => engagersFromApify(apify, signal, now),
    async prescore(agent, people) {
      const prompt = prescorePrompt({ icp: agent, people });
      const parsed = await claude.json("small", prompt.system, prompt.user, prescoreSchema);
      return parsed.results;
    },
    async score(agent, people, ids) {
      const byId = new Map(people.map((person) => [person.profileUrl, person]));
      const prompt = scorePrompt({
        icp: agent,
        rejections: [],
        people: ids.map((id) => byId.get(id) ?? { id }),
      });
      return claude.complete("small", prompt.system, prompt.user);
    },
  };
}
