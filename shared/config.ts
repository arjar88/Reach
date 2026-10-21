/**
 * Ceilings and intervals. Seat settings can only go lower than these.
 * No feature flags until a flag exists.
 */
function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  linkedin: {
    dailyInvites: 15,
    weeklyInvites: 80,
    dailyMessages: 40,
    dailyViews: 30,
    dailyActions: 70,
    inviteNoteMax: 300,
    messageMax: 1900,
    gapMinMinutes: 2,
    gapMaxMinutes: 8,
    rampWeek1: 5,
    rampWeek2: 10,
    rampConnectionFloor: 150,
    acceptanceSample: 100,
    acceptanceMinRate: 0.2,
    inviteTimeoutDays: 21,
    limitStreakDays: 2,
    invitePauseDays: 7,
    weeklyCutFactor: 0.8,
    weeklyCutFloor: 40,
    weeklyCutDays: 14,
    overdueMinutes: 30,
    unknownMinutes: 10,
    maxAttempts: 3,
    defaultLaunchStart: "09:00",
    defaultLaunchEnd: "17:00",
  },
  email: {
    dailyLimit: 30,
    bodyMax: 2000,
    subjectMax: 120,
    blockedCountries: ["IL", "ISRAEL"] as const,
    hiddenWaitDays: 7,
  },
  scrape: {
    maxReactions: 200,
    maxComments: 100,
    maxPostAgeDays: 7,
    maxPostsPerRun: 5,
    rescrapeAfterHours: 48,
    profilesCacheDays: 30,
    companiesCacheDays: 30,
    seenDays: 30,
    engagersDays: 14,
    postsDays: 30,
    providerCallsDays: 30,
    webhookDays: 7,
    cancelledOrgDays: 30,
  },
  scoring: {
    defaultMin: 0.7,
    batchSize: 15,
    retryBatchSize: 5,
    keywordBump: 0.05,
    previewLimit: 20,
    plans: { pilot: 3000, basic: 10000 } as Record<string, number>,
  },
  credits: {
    plans: { pilot: 100, basic: 1000 } as Record<string, number>,
    topUp: 500,
  },
  fetch: {
    intervalHours: 8,
    actorFailuresBeforeSwitch: 2,
  },
  health: {
    heartbeatStaleMinutes: 15,
    queueWaitingMax: 1000,
    queueOldestMinutes: 15,
    outboxStaleMinutes: 2,
    noSendMinutes: 120,
  },
  rateLimit: {
    publicPerMinute: 10,
    authPer10Min: 20,
  },
  queues: {
    fetch: 20,
    signals: 10,
    plan: 10,
    send: 20,
    enrich: 10,
    events: 20,
  },
  workerPoolMax: 8,
  connectSessionMinutes: 30,
} as const;

export function actorPair(primaryEnv: string, backupEnv: string, primary: string, backup: string) {
  return { primary: env(primaryEnv, primary), backup: env(backupEnv, backup) };
}

/** Actor ids stay in config. Override with env when a vendor renames an actor. */
export function actors() {
  return {
    posts: actorPair(
      "APIFY_ACTOR_POSTS",
      "APIFY_ACTOR_POSTS_BACKUP",
      "harvestapi/linkedin-post-search",
      "apimaestro/linkedin-post-search",
    ),
    reactions: actorPair(
      "APIFY_ACTOR_REACTIONS",
      "APIFY_ACTOR_REACTIONS_BACKUP",
      "harvestapi/linkedin-post-reactions",
      "apimaestro/linkedin-post-reactions",
    ),
    comments: actorPair(
      "APIFY_ACTOR_COMMENTS",
      "APIFY_ACTOR_COMMENTS_BACKUP",
      "harvestapi/linkedin-post-comments",
      "apimaestro/linkedin-post-comments",
    ),
    profiles: actorPair(
      "APIFY_ACTOR_PROFILES",
      "APIFY_ACTOR_PROFILES_BACKUP",
      "harvestapi/linkedin-profile-scraper",
      "apimaestro/linkedin-profile-scraper",
    ),
    companies: actorPair(
      "APIFY_ACTOR_COMPANIES",
      "APIFY_ACTOR_COMPANIES_BACKUP",
      "harvestapi/linkedin-company-scraper",
      "apimaestro/linkedin-company-scraper",
    ),
    companySearch: actorPair(
      "APIFY_ACTOR_COMPANY_SEARCH",
      "APIFY_ACTOR_COMPANY_SEARCH_BACKUP",
      "harvestapi/linkedin-company-search",
      "apimaestro/linkedin-company-search",
    ),
    profileSearch: actorPair(
      "APIFY_ACTOR_PROFILE_SEARCH",
      "APIFY_ACTOR_PROFILE_SEARCH_BACKUP",
      "harvestapi/linkedin-profile-search",
      "apimaestro/linkedin-profile-search",
    ),
  };
}

export function models() {
  return {
    small: env("CLAUDE_MODEL_SMALL", "claude-haiku-4-5"),
    strong: env("CLAUDE_MODEL_STRONG", "claude-sonnet-4-5"),
  };
}

export type SignalType = "keyword" | "company_page" | "influencer";
export type StepType = "visit" | "invite" | "message" | "email";
export type ActionType = StepType | "withdraw";
export type ContactStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "in_campaign"
  | "awaiting_acceptance"
  | "replied"
  | "finished"
  | "suppressed";
export type ActionStatus =
  | "pending_approval"
  | "ready"
  | "planned"
  | "sending"
  | "sent"
  | "failed"
  | "skipped"
  | "unknown";
export type EmailStatus = "unknown" | "found" | "not_found" | "bounced" | "hidden";

export const OPEN_ACTION_STATUSES: ActionStatus[] = [
  "pending_approval",
  "ready",
  "planned",
  "sending",
  "unknown",
];

/** Planner deletes these when a campaign is deactivated. In-flight rows stay for reconcile. */
export const DEACTIVATE_DELETE_STATUSES: ActionStatus[] = ["pending_approval", "ready", "planned"];
