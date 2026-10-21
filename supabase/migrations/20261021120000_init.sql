-- Reach schema. Grill wins over the build plan where they differ:
-- person key is normalized profile_url; provider_id is Unipile's id (set on visit);
-- seen_people is per org and per signal_key; campaign_steps.org_id;
-- suppressions.org_id null means global; no profile-viewer tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS auth;

-- Local Postgres has no GoTrue. Hosted Supabase already owns auth.uid(); leave it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS $fn$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $fn$;
  END IF;
END $$;

DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'pilot',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'cancelled')),
  timezone text NOT NULL DEFAULT 'UTC',
  credits_balance integer NOT NULL DEFAULT 0,
  plan_credits_balance integer NOT NULL DEFAULT 0,
  scored_this_month integer NOT NULL DEFAULT 0,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text,
  cancelled_at timestamptz,
  data_deletion_at timestamptz,
  slack_webhook_url text,
  crm_provider text CHECK (crm_provider IS NULL OR crm_provider IN ('hubspot', 'pipedrive')),
  crm_api_key text,
  billing_anchor_day integer NOT NULL DEFAULT 1 CHECK (billing_anchor_day BETWEEN 1 AND 28),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

-- After public.users. PostgreSQL checks LANGUAGE sql bodies at creation time.
CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT org_id FROM public.users WHERE id = auth.uid()
$$;

REVOKE ALL ON FUNCTION app.current_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_org_id() TO authenticated;

CREATE TABLE IF NOT EXISTS company_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  website text,
  description text,
  pain_points text[] NOT NULL DEFAULT '{}',
  features text[] NOT NULL DEFAULT '{}',
  own_company_linkedin_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connect_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('LINKEDIN', 'GOOGLE', 'OUTLOOK')),
  type text NOT NULL CHECK (type IN ('create', 'reconnect')),
  account_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connect_sessions_org_idx ON connect_sessions (org_id);

CREATE TABLE IF NOT EXISTS linkedin_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  unipile_account_id text NOT NULL UNIQUE,
  linkedin_provider_id text UNIQUE,
  unipile_status text NOT NULL DEFAULT 'CONNECTING',
  status_changed_at timestamptz,
  paused_reason text,
  timezone text NOT NULL DEFAULT 'UTC',
  country text,
  is_premium boolean NOT NULL DEFAULT false,
  connected_at timestamptz,
  connections_count integer NOT NULL DEFAULT 0,
  daily_invites integer NOT NULL DEFAULT 15,
  weekly_invites integer NOT NULL DEFAULT 80,
  daily_messages integer NOT NULL DEFAULT 40,
  daily_views integer NOT NULL DEFAULT 30,
  daily_actions integer NOT NULL DEFAULT 70,
  launch_start text NOT NULL DEFAULT '09:00',
  launch_end text NOT NULL DEFAULT '17:00',
  active_days integer[],
  invites_paused_until timestamptz,
  invite_limit_streak integer NOT NULL DEFAULT 0,
  last_invite_limit_on date,
  weekly_cap_factor double precision NOT NULL DEFAULT 1,
  weekly_cap_cut_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS linkedin_seats_org_idx ON linkedin_seats (org_id);

CREATE TABLE IF NOT EXISTS email_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address text NOT NULL,
  unipile_account_id text NOT NULL UNIQUE,
  unipile_status text NOT NULL DEFAULT 'CONNECTING',
  status_changed_at timestamptz,
  paused_reason text,
  timezone text NOT NULL DEFAULT 'UTC',
  daily_limit integer NOT NULL DEFAULT 30,
  launch_start text NOT NULL DEFAULT '09:00',
  launch_end text NOT NULL DEFAULT '17:00',
  active_days integer[],
  domain_check jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_seats_org_idx ON email_seats (org_id);

CREATE TABLE IF NOT EXISTS provider_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seat_id uuid,
  seat_type text,
  route text NOT NULL,
  status_code integer,
  error_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_calls_org_created_idx ON provider_calls (org_id, created_at);

CREATE TABLE IF NOT EXISTS lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lists_org_idx ON lists (org_id);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  list_id uuid REFERENCES lists(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  job_titles text[] NOT NULL DEFAULT '{}',
  industries text[] NOT NULL DEFAULT '{}',
  company_sizes text[] NOT NULL DEFAULT '{}',
  locations text[] NOT NULL DEFAULT '{}',
  mandatory_keywords text[] NOT NULL DEFAULT '{}',
  excluded_companies text[] NOT NULL DEFAULT '{}',
  excluded_names text[] NOT NULL DEFAULT '{}',
  min_score double precision NOT NULL DEFAULT 0.7,
  review_mode boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents (org_id);

CREATE TABLE IF NOT EXISTS signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('keyword', 'company_page', 'influencer')),
  value text NOT NULL,
  signal_key text NOT NULL,
  label text,
  enabled boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  processed_until timestamptz,
  zero_result_runs integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_org_idx ON signals (org_id);
CREATE INDEX IF NOT EXISTS signals_key_idx ON signals (signal_key);

-- Shared LinkedIn data. No org_id. Comment text is never stored.
CREATE TABLE IF NOT EXISTS scraped_posts (
  post_id text PRIMARY KEY,
  signal_key text NOT NULL,
  first_scraped_at timestamptz NOT NULL DEFAULT now(),
  last_scraped_at timestamptz NOT NULL DEFAULT now(),
  scrape_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS post_engagers (
  post_id text NOT NULL,
  profile_url text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reaction', 'comment')),
  signal_key text NOT NULL,
  scraped_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, profile_url, kind)
);
CREATE INDEX IF NOT EXISTS post_engagers_key_scraped_idx ON post_engagers (signal_key, scraped_at);

CREATE TABLE IF NOT EXISTS profiles_cache (
  profile_url text PRIMARY KEY,
  name text,
  headline text,
  title text,
  company_linkedin_id text,
  location text,
  country text,
  is_person boolean,
  scraped_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies_cache (
  company_linkedin_id text PRIMARY KEY,
  name text,
  domain text,
  employee_range text,
  industry text,
  hq_country text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Org table. Written only after a full score. A new signal_key may score again.
CREATE TABLE IF NOT EXISTS seen_people (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_url text NOT NULL,
  signal_key text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  score double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, profile_url, signal_key)
);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  list_id uuid REFERENCES lists(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  campaign_id uuid,
  provider_id text,
  profile_url text NOT NULL,
  name text,
  first_name_clean text,
  title text,
  company text,
  company_linkedin_id text,
  country text,
  network_distance text,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  fit_score double precision,
  score_reason text,
  status text NOT NULL CHECK (status IN (
    'pending_review', 'approved', 'rejected', 'in_campaign', 'awaiting_acceptance',
    'replied', 'finished', 'suppressed'
  )),
  rejected_reason text,
  finished_reason text,
  current_step integer,
  next_step_at timestamptz,
  invited_at timestamptz,
  accepted_at timestamptz,
  linkedin_chat_id text,
  email text,
  email_status text NOT NULL DEFAULT 'unknown' CHECK (email_status IN (
    'unknown', 'found', 'not_found', 'bounced', 'hidden'
  )),
  email_found_at timestamptz,
  email_hidden_at timestamptz,
  enrichment_requested_at timestamptz,
  enrichment_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_profile_idx ON contacts (org_id, profile_url);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_provider_idx ON contacts (org_id, provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_campaign_due_idx ON contacts (campaign_id, next_step_at) WHERE status = 'in_campaign';
CREATE INDEX IF NOT EXISTS contacts_org_idx ON contacts (org_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name text NOT NULL,
  linkedin_seat_id uuid REFERENCES linkedin_seats(id) ON DELETE SET NULL,
  email_seat_id uuid REFERENCES email_seats(id) ON DELETE SET NULL,
  goal text NOT NULL DEFAULT 'conversations' CHECK (goal IN ('conversations', 'demos')),
  tone text NOT NULL DEFAULT 'professional' CHECK (tone IN ('professional', 'direct', 'conversational')),
  language text NOT NULL DEFAULT 'en',
  review_messages boolean NOT NULL DEFAULT true,
  silent_visits boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT false,
  has_contacts boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_org_idx ON campaigns (org_id);

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_campaign_fk;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_campaign_fk FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS campaign_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position integer NOT NULL,
  type text NOT NULL CHECK (type IN ('visit', 'invite', 'message', 'email')),
  delay_days integer NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'fixed')),
  template text,
  subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, position)
);
CREATE INDEX IF NOT EXISTS campaign_steps_org_idx ON campaign_steps (org_id);

CREATE TABLE IF NOT EXISTS actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  campaign_step_id uuid REFERENCES campaign_steps(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('sequence', 'manual')),
  type text NOT NULL CHECK (type IN ('visit', 'invite', 'message', 'email', 'withdraw')),
  linkedin_seat_id uuid REFERENCES linkedin_seats(id) ON DELETE SET NULL,
  email_seat_id uuid REFERENCES email_seats(id) ON DELETE SET NULL,
  content text,
  subject text,
  check_failed_reason text,
  scheduled_for timestamptz,
  status text NOT NULL CHECK (status IN (
    'pending_approval', 'ready', 'planned', 'sending', 'sent', 'failed', 'skipped', 'unknown'
  )),
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  error text,
  sent_at timestamptz,
  external_id text,
  email_message_id text,
  email_provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_one_seat CHECK (num_nonnulls(linkedin_seat_id, email_seat_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS actions_contact_step_idx ON actions (contact_id, campaign_step_id) WHERE campaign_step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS actions_li_status_idx ON actions (linkedin_seat_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS actions_em_status_idx ON actions (email_seat_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS actions_org_idx ON actions (org_id);

CREATE TABLE IF NOT EXISTS threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('linkedin', 'email')),
  external_id text UNIQUE,
  label text CHECK (label IS NULL OR label IN ('interested', 'not_interested', 'out_of_office', 'other')),
  label_reason text,
  ai_draft text,
  last_message_at timestamptz,
  seen boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS threads_org_idx ON threads (org_id);

CREATE TABLE IF NOT EXISTS thread_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  external_id text UNIQUE,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  content text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS thread_messages_org_idx ON thread_messages (org_id);
CREATE INDEX IF NOT EXISTS thread_messages_thread_idx ON thread_messages (thread_id);

CREATE TABLE IF NOT EXISTS suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  profile_url text,
  email text,
  reason text NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppressions_has_target CHECK (profile_url IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_global_profile_idx ON suppressions (profile_url) WHERE org_id IS NULL AND profile_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_org_profile_idx ON suppressions (org_id, profile_url) WHERE org_id IS NOT NULL AND profile_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_global_email_idx ON suppressions (lower(email)) WHERE org_id IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_org_email_idx ON suppressions (org_id, lower(email)) WHERE org_id IS NOT NULL AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS suppressions_org_idx ON suppressions (org_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  amount integer NOT NULL,
  reason text NOT NULL CHECK (reason IN ('plan_grant', 'plan_expiry', 'top_up', 'enrich')),
  ref_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reason, ref_id)
);
CREATE INDEX IF NOT EXISTS credit_ledger_org_idx ON credit_ledger (org_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  dedupe_key text PRIMARY KEY,
  source text NOT NULL,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  payload jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_events_unprocessed_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS job_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'analyze', 'resolve_names', 'preview', 'start_sequences', 'manual_send'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  result jsonb,
  error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_requests_pending_idx ON job_requests (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS job_requests_org_idx ON job_requests (org_id);

-- Quota-zero-today lives in Postgres, per seat-local date.
CREATE TABLE IF NOT EXISTS seat_quota_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL,
  seat_kind text NOT NULL CHECK (seat_kind IN ('linkedin', 'email')),
  action_type text NOT NULL,
  block_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seat_id, action_type, block_date)
);
CREATE INDEX IF NOT EXISTS seat_quota_blocks_org_idx ON seat_quota_blocks (org_id);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_daily_summaries (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, local_date)
);

CREATE TABLE IF NOT EXISTS provider_runtime (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at triggers
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_%I ON %I', r.tablename, r.tablename);
    EXECUTE format(
      'CREATE TRIGGER touch_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
      r.tablename, r.tablename
    );
  END LOOP;
END $$;

-- RLS. Service role / superuser bypasses it. anon and authenticated do not.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE ON SCHEMA app TO authenticated;

-- Org-scoped policies. Shared tables and the outbox have none, so client roles see nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'company_profiles', 'connect_sessions', 'linkedin_seats', 'email_seats',
    'provider_calls', 'lists', 'agents', 'signals', 'seen_people', 'contacts', 'campaigns',
    'campaign_steps', 'actions', 'threads', 'thread_messages', 'credit_ledger',
    'seat_quota_blocks', 'org_daily_summaries'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS org_all ON %I', t);
    EXECUTE format(
      'CREATE POLICY org_all ON %I FOR ALL TO authenticated USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id())',
      t
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS org_all ON organizations;
CREATE POLICY org_all ON organizations FOR ALL TO authenticated
  USING (id = app.current_org_id())
  WITH CHECK (id = app.current_org_id());

-- Authenticated may see this org's suppressions and global ones. Inserts stay org-scoped.
DROP POLICY IF EXISTS org_read ON suppressions;
CREATE POLICY org_read ON suppressions FOR SELECT TO authenticated
  USING (org_id IS NULL OR org_id = app.current_org_id());
DROP POLICY IF EXISTS org_write ON suppressions;
CREATE POLICY org_write ON suppressions FOR ALL TO authenticated
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

-- job_requests is the outbox: client roles get no policy (deny). Polling goes through the service connection and forOrg.
-- webhook_events, scraped_posts, post_engagers, profiles_cache, companies_cache,
-- rate_limit_buckets, worker_heartbeats, provider_runtime: deny all to client roles.
