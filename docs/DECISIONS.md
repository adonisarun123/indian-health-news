# Build log and decisions

Source of truth: `India_Health_News_SRS` v1.0, 19 November 2026.
Last updated: 19 November 2026, end of phase 2.

## Phases

| Phase | Scope | State |
|---|---|---|
| 1 | Schema, signed ingest API, worker, publishing policy, editorial commands, AT-01 to AT-06 | Done |
| 2 | Public site: home, latest, article, source cards, hubs, profiles, search (WEB, UX) | Done |
| 3 | Newsroom: staff sign-in with MFA, queues, editor, approvals UI, source and rights registers, staff HTTP routes (ED, ADM) | Not started |
| 4 | JSON-LD, sitemaps, news sitemap, RSS, cache invalidation and purge (SEO, SD, ARC-02) | Not started |
| 5 | Security checks, AT-07 to AT-16, deploy to Vercel and a worker host (SEC, OPS) | Not started |

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

## Deferred out of phase 1

- **Staff HTTP routes** (`/api/v1/staff/...`). The commands exist and are tested;
  they are not exposed over HTTP until staff sign-in exists in phase 3.
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
11. **Staff sign-in is unspecified in the SRS.** Planned: Auth.js with TOTP.
    Object storage vendor is also unnamed: code will target the S3 API.

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

- Neon project `india-health-news-dev` (`wispy-salad-61286579`), free-plan
  organization, region `aws-ap-southeast-1`, Postgres 17. Dev only.
- No Vercel project and no worker host yet.
