import type { ApifyClient, RawEngager } from "../providers/apify.js";
import type { EngagerInput } from "./pipeline.js";
import { selectPostsToScrape, withinEngagerWindow, type PostCandidate } from "./select.js";

export interface ScrapePlan {
  signalKey: string;
  posts: { postId: string; signalKey: string }[];
  engagers: EngagerInput[];
  /** Profiles that would be cached. Comment text is not a field. */
  profiles: { profileUrl: string; name: string; headline: string; isPerson: true }[];
}

function asEngager(row: RawEngager, postId: string, signalKey: string, now: Date): EngagerInput {
  const detail = signalKey.startsWith("keyword:") ? signalKey.slice("keyword:".length) : postId;
  return {
    profileUrl: row.profileUrl,
    name: row.name,
    headline: row.headline,
    isPerson: true,
    scrapedAt: now.toISOString(),
    detail,
  };
}

/**
 * Reads Apify and returns the rows a commit would store.
 * This function does not write. Callers persist only in commit mode.
 * Globally suppressed profile URLs are removed before any cache row is returned.
 */
export async function planScrape(opts: {
  apify: ApifyClient;
  signalKey: string;
  target: string;
  now: Date;
  knownPosts: PostCandidate[];
  globallySuppressed: ReadonlySet<string>;
}): Promise<ScrapePlan> {
  const listed = await opts.apify.posts({ target: opts.target, maxPosts: 20 });
  const known = new Map(opts.knownPosts.map((p) => [p.postId, p]));
  const candidates: PostCandidate[] = listed.map((post) => {
    const prior = known.get(post.postId);
    return {
      postId: post.postId,
      publishedAt: post.publishedAt,
      scrapeCount: prior?.scrapeCount ?? 0,
      lastScrapedAt: prior?.lastScrapedAt ?? null,
    };
  });
  const selected = selectPostsToScrape(candidates, opts.now);
  const urls = new Map(listed.map((post) => [post.postId, post.url]));
  const engagers: EngagerInput[] = [];
  for (const post of selected) {
    const postUrl = urls.get(post.postId) || post.postId;
    const reactions = await opts.apify.reactions(postUrl);
    const comments = await opts.apify.comments(postUrl);
    for (const row of [...reactions, ...comments]) {
      if (opts.globallySuppressed.has(row.profileUrl)) continue;
      engagers.push(asEngager(row, post.postId, opts.signalKey, opts.now));
    }
  }
  return {
    signalKey: opts.signalKey,
    posts: selected.map((post) => ({ postId: post.postId, signalKey: opts.signalKey })),
    engagers,
    profiles: engagers.map((row) => ({
      profileUrl: row.profileUrl,
      name: row.name,
      headline: row.headline,
      isPerson: true as const,
    })),
  };
}

export function engagersVisibleToSignal<T extends { scrapedAt: string }>(
  rows: T[],
  processedUntil: string | null,
  now: Date,
): T[] {
  return rows.filter((row) => {
    if (!withinEngagerWindow(row.scrapedAt, now)) return false;
    if (!processedUntil) return true;
    return Date.parse(row.scrapedAt) > Date.parse(processedUntil);
  });
}
