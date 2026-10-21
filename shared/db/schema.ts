import { sql } from "drizzle-orm";
import {
  boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("pilot"),
  status: text("status").notNull().default("active"),
  timezone: text("timezone").notNull().default("UTC"),
  creditsBalance: integer("credits_balance").notNull().default(0),
  planCreditsBalance: integer("plan_credits_balance").notNull().default(0),
  scoredThisMonth: integer("scored_this_month").notNull().default(0),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  dataDeletionAt: timestamp("data_deletion_at", { withTimezone: true }),
  slackWebhookUrl: text("slack_webhook_url"),
  crmProvider: text("crm_provider"),
  crmApiKey: text("crm_api_key"),
  billingAnchorDay: integer("billing_anchor_day").notNull().default(1),
  ...ts,
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  ...ts,
}, (t) => [index("users_org_idx").on(t.orgId)]);

export const companyProfiles = pgTable("company_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  website: text("website"),
  description: text("description"),
  painPoints: text("pain_points").array().notNull(),
  features: text("features").array().notNull(),
  ownCompanyLinkedinId: text("own_company_linkedin_id"),
  ...ts,
});

export const connectSessions = pgTable("connect_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  userId: uuid("user_id").notNull(),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  accountId: text("account_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  ...ts,
});

export const linkedinSeats = pgTable("linkedin_seats", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  userId: uuid("user_id").notNull(),
  unipileAccountId: text("unipile_account_id").notNull(),
  linkedinProviderId: text("linkedin_provider_id"),
  unipileStatus: text("unipile_status").notNull().default("CONNECTING"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  pausedReason: text("paused_reason"),
  timezone: text("timezone").notNull().default("UTC"),
  country: text("country"),
  isPremium: boolean("is_premium").notNull().default(false),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  connectionsCount: integer("connections_count").notNull().default(0),
  dailyInvites: integer("daily_invites").notNull().default(15),
  weeklyInvites: integer("weekly_invites").notNull().default(80),
  dailyMessages: integer("daily_messages").notNull().default(40),
  dailyViews: integer("daily_views").notNull().default(30),
  dailyActions: integer("daily_actions").notNull().default(70),
  launchStart: text("launch_start").notNull().default("09:00"),
  launchEnd: text("launch_end").notNull().default("17:00"),
  activeDays: integer("active_days").array(),
  invitesPausedUntil: timestamp("invites_paused_until", { withTimezone: true }),
  inviteLimitStreak: integer("invite_limit_streak").notNull().default(0),
  lastInviteLimitOn: date("last_invite_limit_on"),
  weeklyCapFactor: doublePrecision("weekly_cap_factor").notNull().default(1),
  weeklyCapCutUntil: timestamp("weekly_cap_cut_until", { withTimezone: true }),
  ...ts,
});

export const emailSeats = pgTable("email_seats", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  userId: uuid("user_id").notNull(),
  address: text("address").notNull(),
  unipileAccountId: text("unipile_account_id").notNull(),
  unipileStatus: text("unipile_status").notNull().default("CONNECTING"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  pausedReason: text("paused_reason"),
  timezone: text("timezone").notNull().default("UTC"),
  dailyLimit: integer("daily_limit").notNull().default(30),
  launchStart: text("launch_start").notNull().default("09:00"),
  launchEnd: text("launch_end").notNull().default("17:00"),
  activeDays: integer("active_days").array(),
  domainCheck: jsonb("domain_check"),
  ...ts,
});

export const providerCalls = pgTable("provider_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  seatId: uuid("seat_id"),
  seatType: text("seat_type"),
  route: text("route").notNull(),
  statusCode: integer("status_code"),
  errorType: text("error_type"),
  ...ts,
});

export const lists = pgTable("lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  name: text("name").notNull(),
  ...ts,
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  listId: uuid("list_id"),
  status: text("status").notNull().default("draft"),
  jobTitles: text("job_titles").array().notNull(),
  industries: text("industries").array().notNull(),
  companySizes: text("company_sizes").array().notNull(),
  locations: text("locations").array().notNull(),
  mandatoryKeywords: text("mandatory_keywords").array().notNull(),
  excludedCompanies: text("excluded_companies").array().notNull(),
  excludedNames: text("excluded_names").array().notNull(),
  minScore: doublePrecision("min_score").notNull().default(0.7),
  reviewMode: boolean("review_mode").notNull().default(true),
  ...ts,
});

export const signals = pgTable("signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  type: text("type").notNull(),
  value: text("value").notNull(),
  signalKey: text("signal_key").notNull(),
  label: text("label"),
  enabled: boolean("enabled").notNull().default(true),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  processedUntil: timestamp("processed_until", { withTimezone: true }),
  zeroResultRuns: integer("zero_result_runs").notNull().default(0),
  ...ts,
});

export const scrapedPosts = pgTable("scraped_posts", {
  postId: text("post_id").primaryKey(),
  signalKey: text("signal_key").notNull(),
  firstScrapedAt: timestamp("first_scraped_at", { withTimezone: true }).notNull().defaultNow(),
  lastScrapedAt: timestamp("last_scraped_at", { withTimezone: true }).notNull().defaultNow(),
  scrapeCount: integer("scrape_count").notNull().default(0),
  ...ts,
});

export const postEngagers = pgTable("post_engagers", {
  postId: text("post_id").notNull(),
  profileUrl: text("profile_url").notNull(),
  kind: text("kind").notNull(),
  signalKey: text("signal_key").notNull(),
  scrapedAt: timestamp("scraped_at", { withTimezone: true }).notNull().defaultNow(),
  ...ts,
}, (t) => [primaryKey({ columns: [t.postId, t.profileUrl, t.kind] })]);

export const profilesCache = pgTable("profiles_cache", {
  profileUrl: text("profile_url").primaryKey(),
  name: text("name"),
  headline: text("headline"),
  title: text("title"),
  companyLinkedinId: text("company_linkedin_id"),
  location: text("location"),
  country: text("country"),
  isPerson: boolean("is_person"),
  scrapedId: text("scraped_id"),
  ...ts,
});

export const companiesCache = pgTable("companies_cache", {
  companyLinkedinId: text("company_linkedin_id").primaryKey(),
  name: text("name"),
  domain: text("domain"),
  employeeRange: text("employee_range"),
  industry: text("industry"),
  hqCountry: text("hq_country"),
  ...ts,
});

export const seenPeople = pgTable("seen_people", {
  orgId: uuid("org_id").notNull(),
  profileUrl: text("profile_url").notNull(),
  signalKey: text("signal_key").notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  score: doublePrecision("score"),
  ...ts,
}, (t) => [primaryKey({ columns: [t.orgId, t.profileUrl, t.signalKey] })]);

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  listId: uuid("list_id"),
  agentId: uuid("agent_id"),
  campaignId: uuid("campaign_id"),
  providerId: text("provider_id"),
  profileUrl: text("profile_url").notNull(),
  name: text("name"),
  firstNameClean: text("first_name_clean"),
  title: text("title"),
  company: text("company"),
  companyLinkedinId: text("company_linkedin_id"),
  country: text("country"),
  networkDistance: text("network_distance"),
  signals: jsonb("signals").notNull().default(sql`'[]'::jsonb`),
  fitScore: doublePrecision("fit_score"),
  scoreReason: text("score_reason"),
  status: text("status").notNull(),
  rejectedReason: text("rejected_reason"),
  finishedReason: text("finished_reason"),
  currentStep: integer("current_step"),
  nextStepAt: timestamp("next_step_at", { withTimezone: true }),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  linkedinChatId: text("linkedin_chat_id"),
  email: text("email"),
  emailStatus: text("email_status").notNull().default("unknown"),
  emailFoundAt: timestamp("email_found_at", { withTimezone: true }),
  emailHiddenAt: timestamp("email_hidden_at", { withTimezone: true }),
  enrichmentRequestedAt: timestamp("enrichment_requested_at", { withTimezone: true }),
  enrichmentNotifiedAt: timestamp("enrichment_notified_at", { withTimezone: true }),
  ...ts,
}, (t) => [
  uniqueIndex("contacts_org_profile_idx").on(t.orgId, t.profileUrl),
  index("contacts_org_idx").on(t.orgId),
]);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  listId: uuid("list_id").notNull(),
  name: text("name").notNull(),
  linkedinSeatId: uuid("linkedin_seat_id"),
  emailSeatId: uuid("email_seat_id"),
  goal: text("goal").notNull().default("conversations"),
  tone: text("tone").notNull().default("professional"),
  language: text("language").notNull().default("en"),
  reviewMessages: boolean("review_messages").notNull().default(true),
  silentVisits: boolean("silent_visits").notNull().default(false),
  active: boolean("active").notNull().default(false),
  hasContacts: boolean("has_contacts").notNull().default(false),
  ...ts,
});

export const campaignSteps = pgTable("campaign_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  campaignId: uuid("campaign_id").notNull(),
  position: integer("position").notNull(),
  type: text("type").notNull(),
  delayDays: integer("delay_days").notNull().default(0),
  mode: text("mode").notNull().default("ai"),
  template: text("template"),
  subject: text("subject"),
  ...ts,
});

export const actions = pgTable("actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  campaignStepId: uuid("campaign_step_id"),
  source: text("source").notNull(),
  type: text("type").notNull(),
  linkedinSeatId: uuid("linkedin_seat_id"),
  emailSeatId: uuid("email_seat_id"),
  content: text("content"),
  subject: text("subject"),
  checkFailedReason: text("check_failed_reason"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  externalId: text("external_id"),
  emailMessageId: text("email_message_id"),
  emailProviderId: text("email_provider_id"),
  ...ts,
});

export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  channel: text("channel").notNull(),
  externalId: text("external_id"),
  label: text("label"),
  labelReason: text("label_reason"),
  aiDraft: text("ai_draft"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  seen: boolean("seen").notNull().default(false),
  ...ts,
});

export const threadMessages = pgTable("thread_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  threadId: uuid("thread_id").notNull(),
  externalId: text("external_id"),
  direction: text("direction").notNull(),
  content: text("content"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  ...ts,
});

export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id"),
  profileUrl: text("profile_url"),
  email: text("email"),
  reason: text("reason").notNull(),
  confirmed: boolean("confirmed").notNull().default(false),
  ...ts,
});

export const creditLedger = pgTable("credit_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  refId: text("ref_id").notNull(),
  ...ts,
});

export const webhookEvents = pgTable("webhook_events", {
  dedupeKey: text("dedupe_key").primaryKey(),
  source: text("source").notNull(),
  orgId: uuid("org_id"),
  payload: jsonb("payload"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  ...ts,
});

export const jobRequests = pgTable("job_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("pending"),
  result: jsonb("result"),
  error: text("error"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  ...ts,
});

export const seatQuotaBlocks = pgTable("seat_quota_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  seatId: uuid("seat_id").notNull(),
  seatKind: text("seat_kind").notNull(),
  actionType: text("action_type").notNull(),
  blockDate: date("block_date").notNull(),
  ...ts,
});

export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  bucketKey: text("bucket_key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
  ...ts,
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  detail: jsonb("detail"),
  ...ts,
});

export const orgDailySummaries = pgTable("org_daily_summaries", {
  orgId: uuid("org_id").notNull(),
  localDate: date("local_date").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  ...ts,
}, (t) => [primaryKey({ columns: [t.orgId, t.localDate] })]);

export const providerRuntime = pgTable("provider_runtime", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  ...ts,
});

export const schema = {
  organizations, users, companyProfiles, connectSessions, linkedinSeats, emailSeats, providerCalls,
  lists, agents, signals, scrapedPosts, postEngagers, profilesCache, companiesCache, seenPeople,
  contacts, campaigns, campaignSteps, actions, threads, threadMessages, suppressions, creditLedger,
  webhookEvents, jobRequests, seatQuotaBlocks, rateLimitBuckets, workerHeartbeats, orgDailySummaries,
  providerRuntime,
};
