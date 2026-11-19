# Build log and decisions

Source of truth: `India_Health_News_SRS` v1.0, 19 November 2026.
Last updated: 19 November 2026, end of phase 5.

## Phases

| Phase | Scope | State |
|---|---|---|
| 1 | Schema, signed ingest API, worker, publishing policy, editorial commands, AT-01 to AT-06 | Done |
| 2 | Public site: home, latest, article, source cards, hubs, profiles, search (WEB, UX) | Done |
| 3 | Newsroom: staff sign-in with MFA, queues, editor, approvals UI, source and rights registers, staff HTTP routes (ED, ADM) | Done, with the gaps listed below |
| 4 | JSON-LD, sitemaps, news sitemap, RSS, cache invalidation and purge (SEO, SD, ARC-02) | Done, with the gaps listed below |
| 5 | Security checks, AT-07 to AT-16, deploy to Vercel and a worker host (SEC, OPS) | Done, with the gaps listed below |

## What phase 1 delivers

- All DB-01 relations with constraints: one active feed entry per public identity,
  unique primary section, immutable versions, citations and approvals, append-only
  audit, fixed first-publication time, single-hop redirects.
- `POST /api/v1/ingest/events` and `GET /api/v1/ingest/events/{event_id}` per
  API-01..03: HMAC, five-minute skew, 256 KiB limit, strict v1 validation,
  idempotent replay, producer-scoped receipts, per-producer rate limit.
- Event processing per ING-01, ING-02, ING-05: revision ordering, URL
  normalization and alias conflicts, withdrawal, cluster suggestions, review
  tasks for linked stories.
- Publishing rules per PUB-01: rights, risk, embargo, source state and automation
  switches, evaluated at ingest and again at publication.
- Editorial commands per ADM-02 and ADM-03 as a service layer: create, edit with
  optimistic locking, submit, approve-editorial, approve-medical, return,
  schedule, publish, correct, retract, remove, classify.
- Licensed copies with grant binding, read-time rights checks and expiry sweep.
- Job queue per ING-04 and outbox per ARC-01 with replay protection.
- 21 passing tests, including AT-01 to AT-06.

## What phase 2 delivers

- Reader pages, server-rendered and usable with scripts blocked: `/`, `/latest`,
  `/news/{slug}`, `/section/{slug}`, `/state/{slug}`, `/topic/{slug}`, `/states`,
  `/authors/{slug}`, `/sources/{slug}`, `/search`, `/corrections` and the policy
  pages.
- One SQL definition of "public" (`src/core/reader.ts`) used by every listing,
  hub, profile and search. Suppression and rights are checked on each read.
- Source cards that name the publisher and link straight to it; articles with
  breadcrumb, byline, IST times, primary source above the body, full source
  list, correction note, medical reviewer line and related reports.
- Search over headline, standfirst, body, publisher and taxonomy names, with
  headline matches ranked above body matches, registered spellings (Bangalore
  and Bengaluru), state, section and source filters, and a national fallback
  when a state has little coverage.
- Keyset pagination with stable links on listings; moved addresses redirect in
  one hop; removed stories answer 410 or 451 from `src/proxy.ts`.
- Index policy per page type, gated by the `indexing` rollout flag (off).
- Mobile-first styles from 320 px, a second column at 768 px, lead plus rail at
  1024 px. System fonts, no web-font download.
- 42 passing tests: 32 in `npm test`, 10 over HTTP in `npm run test:site`.

Checked in a headless browser on 13 pages at 320, 360, 390, 768 and 1280 px: no
horizontal overflow, one `h1` per page, every primary control at least 44 px
tall. Article page JavaScript is 136 KiB compressed for modern browsers against
the 170 KiB budget (OPS-02), measured on a local production build.

### Phase 2 decisions and gaps

1. **Pages render per request. Nothing is cached yet.** Correct but not fast:
   the TTFB target (OPS-01) is unmeasured and will not hold under load until the
   cache and invalidation work in phase 4.
2. **Policy pages are placeholders and stay noindex.** About, editorial policy,
   contact, complaints, privacy and terms list what the publisher must supply.
   The editorial-policy page states only rules the system actually enforces.
3. **No reader report form yet** (COR-01). Articles link to `/corrections`,
   which has no working channel until the publisher supplies a contact and the
   cases queue exists (phase 3).
4. **No images.** Every layout is text-led until the media pipeline exists.
5. **Search uses numbered pages capped at 50**, not a cursor. Accent folding is
   applied to the query only, not the index.
6. **A hub is indexable only with an editor's introduction, explicit approval
   and five original stories.** Empty topic hubs return 404. States without
   coverage are listed as text, not linked.
7. **Homepage lead** is the highest `lead_rank`, else the newest original
   report. The breaking strip has a table and renders, with no newsroom control
   until phase 3.
8. **Not verified:** screen readers (TalkBack, VoiceOver), 200% zoom, reduced
   motion, the five-reader usability gate (UX-05), field Web Vitals, analytics
   events (OPS-04). These are phase 5 or need people.

## What phases 3 to 5 deliver

**Phase 3, newsroom**
- Staff sign-in: scrypt passwords, mandatory TOTP, single-use invitations,
  lockout after five failures, database sessions that an administrator can end
  at once. No third-party identity service.
- Newsroom at `/newsroom`: queue of held and waiting items with reasons and
  next actions, story editor with versioning, approvals and preview, source and
  rights register, reader cases, staff administration, settings and audit trail.
- Staff API per ADM-02 and ADM-05, with session and same-origin checks.
- Reader report form with case numbers, rate limiting and private contacts.
- Policy pages are versioned documents; publisher facts come from settings.

**Phase 4, discovery**
- JSON-LD on every template, built from the published record, with a
  structural validator. Sitemap index and shards, news sitemap, robots.txt,
  site and section RSS.
- Listings are cached for at most one minute and dropped on every publication
  event. Story pages are always read live.

**Phase 5, hardening**
- Reconciliation after a restore: suppression decisions are reapplied, lost
  scheduled jobs restored, stories without a source reported (OPS-03).
- Security headers and a content security policy with no third-party origins.
- 68 passing tests: 52 in `npm test`, 16 over HTTP in `npm run test:site`.

### Acceptance test status

| Test | Status | What is and is not covered |
|---|---|---|
| AT-01 to AT-06 | Automated | Full |
| AT-07 | Automated | Retraction, 410/451, feeds, search and recovery by reconciliation. A real backup restore has not been rehearsed. |
| AT-08 | Partly automated | Lease expiry, dead letters, replay, source isolation, missed scheduled job. Source 429 and parser drift belong to the scraper, which does not exist yet. |
| AT-09 | Automated | Full |
| AT-10 | Automated | Full, against 1,002 fixture stories |
| AT-11 | Automated | Graph and page parity. Google's Rich Results Test has not been run: it needs a public URL. |
| AT-12 | Partly | Overflow, heading and touch-target checks at five widths in a headless browser. No screen reader, zoom or reduced-motion testing. |
| AT-13 | Not done | Needs load tooling, India-based probes and field traffic. |
| AT-14 | Partly automated | Unapproved URL, protected preview, case details absent from public pages. No media pipeline exists, so there is no restricted asset to test. |
| AT-15 | Automated | Aliases, empty-state recovery, broken-link status and verification task |
| AT-16 | Partly automated | Correction behaviour. Restore timing (RPO 15 min, RTO 4 h) has not been measured. |

### Decisions in phases 3 to 5

1. **Sign-in is built in, not Auth.js.** Its password provider has no second
   factor and no server-side revocation, which SEC-02 needs.
2. **`body_text` added to the scraper contract.** Plain text only. It is
   discarded at intake unless the grant in force covers full text.
3. **A partner copy auto-publishes only when** the grant covers full text, the
   global and per-source switches are on, the source has a default section and
   the item carries no risk flag. It replaces the source card for that item.
4. **Policy text is a draft.** Privacy, terms and complaints were written to
   describe what the platform does. They are not legal advice and are noindex
   until a reviewer is recorded and the publisher details are complete.
5. **Story pages are not cached.** An earlier design cached them and a test
   showed it could serve stale content. Only listings and navigation are cached.
6. **Work runs after the response** on ingest and newsroom actions, so a
   separate worker is optional for a pilot. Scheduled releases and rights
   sweeps still need a regular tick: the standalone worker (`npm run worker`)
   or a cron call to `/api/internal/tick`.
7. **The newsroom shares the public layout.** It is functional, not designed.
8. **No analytics events** (OPS-04) and no error tracking service are wired in.

## Deferred out of phase 1

- **Media pipeline.** Tables exist. No upload, renditions or delivery yet.
- **Outbox delivery targets.** Events fan out to named targets and are logged.
  Real cache invalidation, purge, RSS and sitemap rebuilds arrive in phase 4.
- **Fetching** (SRC-03, ING-03 pacing, robots, conditional GET). The SRS assigns
  this to the scraper team. Nothing here fetches a third-party URL.

## Where this build departs from or interprets the SRS

1. **The v1 ingest contract cannot feed licensed republication.** API-02 lists
   excerpt, author, document URL and media candidates, and no body text. A partner
   copy therefore needs an editor to supply the body. "Low-risk partner feeds may
   post automatically" (PUB table) is unreachable until the contract gains a body
   field. Needs an SRS decision before phase 3.
2. **Any edit invalidates approvals**, not only a "material" one (ED-04). Approvals
   bind to an exact immutable version. Stricter than the SRS and simpler to audit.
3. **Risk routing is a keyword screen**, not a classifier (`src/core/risk.ts`). It
   over-flags by design. A managing editor can reclassify with a recorded reason.
4. **A risk-flagged source card cannot be released as a card at all.** The SRS
   requires editor and medical sign-off on an exact version for clinical items;
   only the article workflow provides that.
5. **Extra optional contract fields**: `resolved_url`, `canonical_url`,
   `adapter_version`, `source_published_at_reason`, and `reason` on withdrawal.
   ING-01 requires storing them; API-02 does not name them.
6. **Same item and revision under a new event ID**: identical content is accepted
   and recorded as superseded; different content is a 409.
7. **A paused or revoked source is refused at intake with 403.** A proposed or
   under-review source is accepted and held, so onboarding trials (SRC-04) work.
8. **A published clinical story whose primary source is withdrawn upstream is
   pulled automatically** pending review (COR-02 "suppress unsafe clinical
   claims"). Routine stories only get a review task.
9. **Receipt polling is signed** like a POST with an empty body:
   HMAC over `timestamp + "." + event_id + "."`.
10. **An expired licensed copy returns 410.** The SRS does not name a status for
    rights expiry.
11. **Staff sign-in is unspecified in the SRS.** Built in: see phase 3.
    Object storage vendor is also unnamed and no media pipeline exists yet.

## Not software, and blocking launch

- Signed source grants. Without them the only lawful output is link-only source
  cards and original reporting.
- A medical reviewer roster with verifiable credentials.
- Adviser sign-off on DPDP, CERT-In and digital-news publisher obligations
  (GOV-01, SEC-04).
- Field evidence: 28-day Web Vitals, the five-reader usability gate, load and
  restore rehearsals.
- A real scraper. Phase 1 ships a fixture producer only.

## Infrastructure

- **Code:** github.com/adonisarun123/indian-health-news, branch `main`.
- **Database:** the Neon database supplied on 19 November 2026 (endpoint
  `ep-soft-feather-b3jn6g1u`, Singapore, Postgres 18). Migrated and seeded with
  taxonomy, search synonyms and the six policy pages. No demo content.
- **Web:** Vercel project `indian-health-news`, deploying from `main` to
  https://indian-health-news.vercel.app. Functions run in Singapore (`sin1`),
  the same region as the database.
  Production environment variables: `DATABASE_URL`, `INGEST_SECRET_KEY`,
  `CRON_SECRET`, `SITE_NAME`. Preview deployments have no database on purpose.
- **Scheduler:** `vercel.json` calls `/api/internal/tick` once a day, the most a
  Hobby plan allows. Ingest and newsroom actions process their own work
  straight after the response, so day-to-day publishing does not wait for it.
  Scheduled releases and rights-expiry sweeps do: for those, raise the cron to
  every minute on a paid plan or run `npm run worker` on a host.
- **Unused:** the earlier Neon dev project `india-health-news-dev`
  (`wispy-salad-61286579`) still exists with fictional demo data. Its
  connection details are in `.env.local.dev-backup` on the development Mac.
- **Not provisioned:** object storage, CDN purge, error tracking, analytics,
  independent backups, a worker host.

## Index policy change, 19 November 2026

The publisher asked for every page to be indexable. This overrides PUB-03 and
the hub and policy-page thresholds recorded above (phase 2, items 2 and 6).

- **Indexable:** every published story of any type, including partner copies
  and press material; the homepage, `/latest`, `/states` and `/corrections`;
  all six policy pages; any section, state, topic, source or author page that
  has public material.
- **Still noindex, on purpose:** the newsroom and API; search result pages;
  cursor pages (`?before=`), which canonicalise to an unstable address; a
  retracted story; a removed story (410 or 451); a hub with nothing in it,
  which would be a soft 404.
- **Sitemaps:** the general sitemap lists every indexable story. The news
  sitemap lists our own writing only and leaves out republished partner copies.
- Migration `0004_index_all` relaxes the licensed-copy constraint and marks
  published stories indexable. The `indexing` rollout flag was switched on in
  production the same day.
- Known cost: republished releases duplicate their source, so search engines
  will usually prefer the original. Policy pages are indexed while they still
  show the "details to be confirmed" notice.
