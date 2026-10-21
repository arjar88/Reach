import { config } from "../../../../shared/config.js";
import type { EngagerInput } from "../../../../shared/signals/pipeline.js";
import { selectPostsToScrape } from "../../../../shared/signals/select.js";
import type { ApifyClient } from "../../../../shared/providers/apify.js";

/** Read posts and engagers. This does not write posts, profiles, or contacts. */
export async function engagersFromApify(
  apify: Pick<ApifyClient, "posts" | "reactions" | "comments">,
  signal: { value: string; signalKey: string },
  now: Date,
): Promise<EngagerInput[]> {
  const listed = await apify.posts({ target: signal.value, maxPosts: config.scrape.maxPostsPerRun });
  const candidates = listed
    .filter((post) => post.postId && post.publishedAt)
    .map((post) => ({
      postId: post.postId,
      publishedAt: post.publishedAt,
      scrapeCount: 0,
      lastScrapedAt: null,
    }));
  const selected = selectPostsToScrape(candidates, now);
  const urls = new Map(listed.map((post) => [post.postId, post.url || post.postId]));
  const engagers: EngagerInput[] = [];
  for (const post of selected) {
    const postUrl = urls.get(post.postId) || post.postId;
    const reactions = (await apify.reactions(postUrl)).slice(0, config.scrape.maxReactions);
    const comments = (await apify.comments(postUrl)).slice(0, config.scrape.maxComments);
    const detail = signal.signalKey.startsWith("keyword:") ? signal.signalKey.slice("keyword:".length) : post.postId;
    for (const row of [...reactions, ...comments]) {
      engagers.push({
        profileUrl: row.profileUrl,
        name: row.name,
        headline: row.headline,
        isPerson: true,
        scrapedAt: now.toISOString(),
        detail,
      });
    }
  }
  return engagers;
}
