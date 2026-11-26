# India Health News

Platform for a mobile health news publication: a scraper submits items to a private
API, the platform decides how each item may appear, records that decision and
distributes approved content. Built from `India_Health_News_SRS` v1.0 (19 Nov 2026).

**Status: all five phases built.** Not launch-ready: see the acceptance test
table and the "not software" list in the decisions file.
See [docs/DECISIONS.md](docs/DECISIONS.md) for what is built, what is deferred and
where this build departs from the SRS.

## Stack

Next.js App Router and TypeScript · Neon PostgreSQL · Drizzle ORM with SQL
migrations · Node worker on a PostgreSQL job table and transactional outbox ·
Zod · Vitest.

## Layout

| Path | What it holds |
|---|---|
| `src/db/schema.ts`, `drizzle/` | Schema and reviewed SQL migrations (DB-01..03) |
| `src/core/ingest/` | Intake contract, signed receive endpoint logic, event processing |
| `src/core/policy.ts` | Publishing rules as pure functions (PUB-01..03) |
| `src/core/risk.ts` | Medical-risk keyword screen |
| `src/core/cards.ts` | External source cards |
| `src/core/articles.ts` | Editorial commands: versions, approvals, publish, correct, retract |
| `src/core/outbox.ts` | Publication event delivery, replay protection |
| `src/core/public.ts`, `src/core/reader.ts` | Published projection: the only read path for public pages, listings and search |
| `src/app/`, `src/components/` | Reader pages and components |
| `src/proxy.ts` | 410 and 451 responses for removed stories |
| `src/core/auth.ts`, `src/app/newsroom/` | Staff sign-in and the newsroom |
| `src/core/sources.ts`, `cases.ts`, `settings.ts` | Source and rights register, reader cases, publisher settings and policy pages |
| `src/core/jsonld.ts`, `src/app/sitemap.xml/`, `feed.xml/` | Structured data, sitemaps and RSS |
| `src/core/reconcile.ts` | Post-restore reconciliation |
| `src/core/jobs.ts`, `src/worker/` | Durable queue, worker loop, scheduler tick |
| `src/app/api/v1/ingest/` | `POST /events`, `GET /events/{event_id}` |
| `scripts/produce.ts`, `fixtures/` | Fixture producer for tests and local checks |
| `scraper/` | The scraper: feeds and news sitemaps to signed intake events (`npm run scrape`; see `scraper/README.md` and `docs/SCRAPER-HANDOVER.md`) |
| `tests/` | Acceptance tests AT-01 to AT-06, queue recovery, policy, reader queries, site over HTTP |

## Run it

```bash
npm install
cp .env.example .env.local        # fill DATABASE_URL, DATABASE_URL_DIRECT, INGEST_SECRET_KEY
npm run db:migrate
npm run db:seed -- --demo         # dev only; demo newsroom, sources and stories; prints producer secrets

npm run staff -- invite --email you@example.com --name "Your Name" --roles administrator,managing_editor,editor
                                  # prints a one-time link to set a password and authenticator

npm run dev                       # terminal 1: web, newsroom at /newsroom, intake API
npm run worker                    # terminal 2: background worker
npm run produce -- fixtures/events/notice-204-r1.json   # terminal 3: submit a signed event
```

`notice-204-r1.json` becomes a public source card. `drug-alert-held.json` is held
for medical review. `unknown-grant-held.json` is held because the source has no
grant on record.

## Test

```bash
npm run test:db    # Postgres 17 in Docker on port 5433 (or set TEST_DATABASE_URL)
npm test
npm run test:site  # builds, then checks the reader site over HTTP
npm run typecheck
```

The suite builds one migrated template database and clones it per test file. All
tests use fixed clocks.
