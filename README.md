# Reach

Phase 1 is the monorepo, database, pure engines, auth shell, and worker boot. Onboarding screens live in the leads slice. This worker runs `analyze`, `resolve_names`, and `preview` jobs those screens insert. Profile viewers and later signals are deferred (`docs/later-signals.md`).

## Local

Postgres and Redis on this machine:

```bash
pnpm i
pnpm db:migrate
pnpm db:seed
pnpm dev
pnpm worker:dev
```

`DATABASE_URL_SESSION` defaults in `.env.example` to `postgres://reach:reach@127.0.0.1:5432/reach`. Tests use `reach_test`. Redis must be `maxmemory-policy noeviction`. The worker refuses to boot otherwise.

With the Supabase CLI and Docker:

```bash
supabase start
docker run --name reach-redis -p 6379:6379 redis:7 --maxmemory-policy noeviction --appendonly yes
```

Copy `.env.example` to `.env`. Auth needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Without them, sign-in shows that Supabase is not configured and does not pretend the session exists.

The web pool uses the transaction pooler (`prepare: false`, max 10). The worker pool max is 8.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Deploy

Not deployed from this tree. The CLIs were not authenticated.

- Supabase: `supabase login`, `supabase link`, `supabase db push` with `DATABASE_URL_SESSION`.
- Vercel: project root `apps/web`, region `fra1`. Cron `GET /api/cron/worker-health` daily at 08:00 UTC. Set `CRON_SECRET`. The route returns 503 when the heartbeat is stale and `RESEND_API_KEY` is missing.
- Railway: worker start `node apps/worker/dist/index.js` (`pnpm --filter @reach/worker build`), Redis `noeviction` and AOF.

Vendor keys (`UNIPILE_*`, `APIFY_TOKEN`, `ANTHROPIC_API_KEY`, enrichment, `STRIPE_*`, `RESEND_API_KEY`) are not required for the test suite. `analyze` and `preview` fail the job row when a required key is missing.
