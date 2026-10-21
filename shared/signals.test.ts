import { describe, expect, it, vi } from "vitest";
import { config } from "./config.js";
import { toEngager, createApify } from "./providers/apify.js";
import { applySignalWrites } from "./signals/commit.js";
import { engagersVisibleToSignal, planScrape } from "./signals/fetch.js";
import { runSignalPipeline, type AgentFilter, type EngagerInput } from "./signals/pipeline.js";
import { runWatchedSignal } from "./signals/run.js";
import { selectPostsToScrape } from "./signals/select.js";

const now = new Date("2026-10-21T12:00:00.000Z");
const day = 86_400_000;

const agent: AgentFilter = {
  minScore: 0.7,
  reviewMode: true,
  mandatoryKeywords: ["pricing"],
  excludedCompanies: ["111"],
  excludedNames: ["Acme"],
  jobTitles: ["VP Sales"],
  industries: ["software"],
  companySizes: ["11-50"],
  locations: ["US"],
};

function engager(overrides: Partial<EngagerInput> = {}): EngagerInput {
  return {
    profileUrl: "https://www.linkedin.com/in/ada",
    name: "Ada Lovelace",
    headline: "VP Sales",
    title: "VP Sales",
    company: "Example",
    companyLinkedinId: "999",
    isPerson: true,
    scrapedAt: "2026-10-21T11:00:00.000Z",
    detail: "example.com/posts/1",
    ...overrides,
  };
}

function read(flags: { existing?: string[]; seen?: string[]; suppressed?: string[] } = {}) {
  const existing = new Set(flags.existing ?? []);
  const seen = new Set(flags.seen ?? []);
  const suppressed = new Set(flags.suppressed ?? []);
  return {
    existing: async (url: string) => existing.has(url),
    seen: async (url: string) => seen.has(url),
    suppressed: async (url: string) => suppressed.has(url),
  };
}

function scoreAll(score: number) {
  return async (ids: string[]) => JSON.stringify({
    results: ids.map((id) => ({ id, score, reason: "fits the buying group" })),
  });
}

describe("signals", () => {
  it("scrapes a post when it is new and once more after 48 hours", () => {
    const ids = selectPostsToScrape([
      { postId: "new", publishedAt: new Date(now.getTime() - day).toISOString(), scrapeCount: 0, lastScrapedAt: null },
      { postId: "too-soon", publishedAt: new Date(now.getTime() - 2 * day).toISOString(), scrapeCount: 1, lastScrapedAt: new Date(now.getTime() - 47 * 3_600_000).toISOString() },
      { postId: "again", publishedAt: new Date(now.getTime() - 3 * day).toISOString(), scrapeCount: 1, lastScrapedAt: new Date(now.getTime() - 49 * 3_600_000).toISOString() },
      { postId: "settled", publishedAt: new Date(now.getTime() - day).toISOString(), scrapeCount: 2, lastScrapedAt: new Date(now.getTime() - 3 * day).toISOString() },
      { postId: "old", publishedAt: new Date(now.getTime() - 8 * day).toISOString(), scrapeCount: 0, lastScrapedAt: null },
    ], now).map((post) => post.postId);
    expect(ids).toEqual(["new", "again"]);
  });

  it("does not call Apify for a settled post and drops a globally suppressed profile before the cache", async () => {
    let reactions = 0;
    const plan = await planScrape({
      apify: {
        posts: async () => [
          { postId: "settled", url: "https://www.linkedin.com/posts/settled", publishedAt: now.toISOString(), textPreview: null },
          { postId: "new", url: "https://www.linkedin.com/posts/new", publishedAt: now.toISOString(), textPreview: null },
        ],
        reactions: async (postUrl: string) => {
          reactions += 1;
          expect(postUrl).toContain("new");
          return [
            { profileUrl: "https://www.linkedin.com/in/ada", name: "Ada", headline: "VP", kind: "reaction" },
            { profileUrl: "https://www.linkedin.com/in/hidden", name: "Hidden", headline: "VP", kind: "reaction" },
          ];
        },
        comments: async () => [],
        profiles: async () => [],
        companies: async () => [],
        searchCompanies: async () => [],
        searchProfiles: async () => [],
        actorState: () => ({} as never),
        switchedActors: () => [],
      },
      signalKey: "company_page:acme",
      target: "https://www.linkedin.com/company/acme",
      now,
      knownPosts: [{ postId: "settled", publishedAt: now.toISOString(), scrapeCount: 2, lastScrapedAt: now.toISOString() }],
      globallySuppressed: new Set(["https://www.linkedin.com/in/hidden"]),
    });
    expect(reactions).toBe(1);
    expect(plan.posts.map((post) => post.postId)).toEqual(["new"]);
    expect(plan.engagers.map((row) => row.profileUrl)).toEqual(["https://www.linkedin.com/in/ada"]);
    expect(plan.profiles.map((row) => row.profileUrl)).toEqual(["https://www.linkedin.com/in/ada"]);
  });

  it("drops comment text and normalizes the profile URL", () => {
    const row = toEngager({
      profileUrl: "HTTPS://www.linkedin.com/in/Ada/",
      text: "secret comment body",
      comment: "also secret",
      headline: "VP Sales",
      name: "Ada",
    }, "comment");
    expect(row?.profileUrl).toBe("https://www.linkedin.com/in/ada");
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(row && "text" in row).toBe(false);
  });

  it("advances processed_until only after the contact upsert in the commit transaction", async () => {
    const later = "2026-10-21T11:30:00.000Z";
    const result = await runSignalPipeline({
      mode: "commit",
      orgId: "org-a",
      signalId: "sig",
      signalKey: "keyword:pricing",
      signalType: "keyword",
      agent: { ...agent, reviewMode: false, mandatoryKeywords: [] },
      engagers: [engager({ scrapedAt: "2026-10-21T10:00:00.000Z" }), engager({ profileUrl: "https://www.linkedin.com/in/bea", name: "Bea", scrapedAt: later })],
      now,
      read: read(),
      prescore: async (people) => people.map((p) => ({ id: p.id, keep: true })),
      score: scoreAll(0.9),
    });
    expect(result.write?.processedUntil).toBe(later);
    expect(result.write?.contacts).toHaveLength(2);
    const order: string[] = [];
    await applySignalWrites({
      upsertContact: async () => { order.push("contact"); },
      upsertSeen: async () => { order.push("seen"); },
      appendSignal: async () => { order.push("append"); },
      advanceCursor: async (write) => { order.push(`cursor:${write.processedUntil}`); },
    }, result.write!);
    expect(order[0]).toBe("contact");
    expect(order.at(-1)).toBe(`cursor:${later}`);
    const failed: string[] = [];
    await expect(applySignalWrites({
      upsertContact: async () => { failed.push("contact"); throw new Error("boom"); },
      upsertSeen: async () => { failed.push("seen"); },
      appendSignal: async () => { failed.push("append"); },
      advanceCursor: async () => { failed.push("cursor"); },
    }, result.write!)).rejects.toThrow("boom");
    expect(failed).toEqual(["contact"]);
  });

  it("drops competitor staff, seen people, and excluded names, and appends a signal on an existing contact", async () => {
    const ada = "https://www.linkedin.com/in/ada";
    const staff = engager({ profileUrl: "https://www.linkedin.com/in/staff", companyLinkedinId: "111", name: "Staff" });
    const seen = engager({ profileUrl: "https://www.linkedin.com/in/seen", name: "Seen" });
    const named = engager({ profileUrl: "https://www.linkedin.com/in/named", headline: "Engineer at Acme", name: "Named" });
    const existing = engager({ profileUrl: ada, detail: "acme pricing post" });
    const fresh = engager({ profileUrl: "https://www.linkedin.com/in/fresh", name: "Fresh", headline: "VP Sales pricing" });
    const prescored: string[] = [];
    const result = await runSignalPipeline({
      mode: "commit",
      orgId: "org-a",
      signalId: "sig",
      signalKey: "company_page:rival",
      signalType: "company_page",
      agent,
      engagers: [staff, seen, named, existing, fresh],
      now,
      read: read({ existing: [ada], seen: [seen.profileUrl] }),
      prescore: async (people) => {
        prescored.push(...people.map((p) => p.id));
        return people.map((p) => ({ id: p.id, keep: true }));
      },
      score: scoreAll(0.66),
    });
    expect(prescored).not.toContain(staff.profileUrl);
    expect(prescored).not.toContain(seen.profileUrl);
    expect(prescored).not.toContain(named.profileUrl);
    expect(prescored).not.toContain(ada);
    expect(result.write?.appends).toEqual([{ profileUrl: ada, detail: "acme pricing post", at: existing.scrapedAt }]);
    expect(result.write?.contacts.map((c) => c.profileUrl)).toEqual([fresh.profileUrl]);
    expect(result.write?.seen.map((row) => row.profileUrl)).not.toContain(seen.profileUrl);
    const bumped = result.write?.contacts[0]?.score ?? 0;
    expect(bumped).toBeCloseTo(0.66 + config.scoring.keywordBump);
  });

  it("lets a keyword move the score and still keeps a strong lead that misses the keyword", async () => {
    const withKeyword = engager({ profileUrl: "https://www.linkedin.com/in/key", headline: "Thinking about pricing" });
    const strong = engager({ profileUrl: "https://www.linkedin.com/in/strong", headline: "VP Sales" });
    const weak = engager({ profileUrl: "https://www.linkedin.com/in/weak", headline: "VP Sales" });
    const result = await runSignalPipeline({
      mode: "commit",
      orgId: "org-a",
      signalId: "sig",
      signalKey: "keyword:pricing",
      signalType: "keyword",
      agent,
      engagers: [withKeyword, strong, weak],
      now,
      read: read(),
      prescore: async (people) => people.map((p) => ({ id: p.id, keep: true })),
      score: async (ids) => JSON.stringify({
        results: ids.map((id) => ({ id, score: id.endsWith("strong") ? 0.91 : 0.68, reason: "scored" })),
      }),
    });
    const urls = result.write?.contacts.map((c) => c.profileUrl).sort();
    expect(urls).toEqual([strong.profileUrl, withKeyword.profileUrl].sort());
    expect(result.write?.seen.map((row) => row.profileUrl)).toEqual([weak.profileUrl]);
  });

  it("does not write seen_people for a pre-score no", async () => {
    const result = await runSignalPipeline({
      mode: "commit",
      orgId: "org-a",
      signalId: "sig",
      signalKey: "keyword:pricing",
      signalType: "keyword",
      agent,
      engagers: [engager()],
      now,
      read: read(),
      prescore: async () => [{ id: engager().profileUrl, keep: false }],
      score: scoreAll(0.99),
    });
    expect(result.write?.seen).toEqual([]);
    expect(result.write?.contacts).toEqual([]);
    expect(result.dropped.map((row) => row.reason)).toContain("prescore");
  });

  it("preview writes nothing", async () => {
    const persist = vi.fn();
    const result = await runWatchedSignal({
      mode: "preview",
      orgId: "org-a",
      signalId: "sig",
      signalKey: "keyword:pricing",
      signalType: "keyword",
      agent: { ...agent, reviewMode: false, mandatoryKeywords: [] },
      engagers: [engager(), engager({ profileUrl: "https://www.linkedin.com/in/bea", name: "Bea" })],
      now,
      read: read({ existing: ["https://www.linkedin.com/in/ada"] }),
      prescore: async (people) => people.map((p) => ({ id: p.id, keep: true })),
      score: scoreAll(0.95),
      persist,
    });
    expect(result.write).toBeNull();
    expect(result.persisted).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(result.people.map((p) => p.profileUrl)).toEqual(["https://www.linkedin.com/in/bea"]);
  });

  it("a new org reads shared engagers from the last 14 days", () => {
    const recent = new Date(now.getTime() - 10 * day).toISOString();
    const stale = new Date(now.getTime() - 20 * day).toISOString();
    const rows = [{ id: "recent", scrapedAt: recent }, { id: "stale", scrapedAt: stale }];
    expect(engagersVisibleToSignal(rows, null, now).map((row) => row.id)).toEqual(["recent"]);
    expect(engagersVisibleToSignal(rows, recent, now)).toEqual([]);
  });

  it("switches to the backup actor after two failures", async () => {
    process.env.APIFY_TOKEN = "test-token";
    const urls: string[] = [];
    const http = async (url: string) => {
      urls.push(url);
      if (url.includes("harvestapi")) return { status: 500, text: "no", json: null };
      return { status: 200, text: "[]", json: [] };
    };
    const client = createApify(http, "test-token");
    await expect(client.posts({ target: "acme", maxPosts: 5 })).rejects.toThrow(/failed/);
    await client.posts({ target: "acme", maxPosts: 5 });
    expect(client.switchedActors()).toContain("posts");
    expect(urls.some((url) => url.includes("apimaestro"))).toBe(true);
  });
});
