# Build log and decisions

Source of truth: `India_Health_News_SRS` v1.0, 19 November 2026.
Last updated: 19 November 2026, end of phase 1.

## Phases

| Phase | Scope | State |
|---|---|---|
| 1 | Schema, signed ingest API, worker, publishing policy, editorial commands, AT-01 to AT-06 | Done |
| 2 | Public site: home, latest, article, source cards, hubs, search (WEB, UX) | Not started |
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

## Deferred out of phase 1

- **Staff HTTP routes** (`/api/v1/staff/...`). The commands exist and are tested;
  they are not exposed over HTTP until staff sign-in exists in phase 3.
- **Full-text search index** (DB-02 GIN index). Phase 2, with search.
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
