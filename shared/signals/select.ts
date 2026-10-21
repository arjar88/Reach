import { config } from "../config.js";

export interface PostCandidate {
  postId: string;
  publishedAt: string;
  scrapeCount: number;
  lastScrapedAt: string | null;
}

/** New posts, and posts scraped once that are at least 48 hours old. At most 5, at most 7 days old. */
export function selectPostsToScrape(posts: PostCandidate[], now: Date): PostCandidate[] {
  const maxAge = config.scrape.maxPostAgeDays * 86_400_000;
  const rescrape = config.scrape.rescrapeAfterHours * 3_600_000;
  const fresh = posts
    .filter((p) => now.getTime() - Date.parse(p.publishedAt) <= maxAge)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, config.scrape.maxPostsPerRun);
  return fresh.filter((p) => {
    if (p.scrapeCount <= 0) return true;
    if (p.scrapeCount === 1 && p.lastScrapedAt) return now.getTime() - Date.parse(p.lastScrapedAt) >= rescrape;
    return false;
  });
}

export interface ActorSwitchState {
  active: "primary" | "backup";
  consecutiveFailures: number;
}

export function nextActorState(state: ActorSwitchState, result: "ok" | "fail"): ActorSwitchState & { switched: boolean } {
  if (result === "ok") return { active: state.active, consecutiveFailures: 0, switched: false };
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= config.fetch.actorFailuresBeforeSwitch && state.active === "primary") {
    return { active: "backup", consecutiveFailures: 0, switched: true };
  }
  return { active: state.active, consecutiveFailures, switched: false };
}

export function signalsToFanout(rows: { id: string; signalKey: string; enabled: boolean; agentStatus: string }[], key: string): string[] {
  return rows.filter((r) => r.signalKey === key && r.enabled && r.agentStatus === "active").map((r) => r.id);
}

export function withinEngagerWindow(scrapedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(scrapedAt) <= config.scrape.engagersDays * 86_400_000;
}
