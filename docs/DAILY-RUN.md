# Daily content run

Set up 23 November 2026 on the publisher's instruction: new content every day.
A scheduled Claude task runs this each evening. It needs the publisher's Mac
awake with the Claude desktop app open, because pib.gov.in and the database are
reached from that machine. A missed day is caught up by the next run.

## 1. PIB releases: published automatically

On the Mac, in this folder:

    npm run pib -- daily --as adonis.arun@gmail.com --override-risk

Publishes every Health and Family Welfare, Ayush and Department of
Pharmaceuticals release issued this month that is not on the site yet (PIB
ministry codes 31, 80 and 41; from code 41 only releases issued by the
Department of Pharmaceuticals are taken, not Fertilizers or Chemicals and
Petrochemicals). Releases the risk screen holds are reclassified as
routine and published without medical review: a standing publisher decision,
recorded in the audit trail each time. Housekeeping items and previews are left
out by the rules in `scripts/pib-import.ts`. Read the three tally lines; `failed`
must be 0.

The importer reads the listing of **every PIB office** (Delhi and all 28
regional offices), not only PIB Delhi: releases issued through a regional
office (AIIMS events, FSSAI regional programmes) appear only there. A release
reissued by another office under a new PRID is matched on issue date and title
and left out. Because of the 29 listings per ministry the run takes roughly
5 to 10 minutes.

Each ministry also prints a line like
`{"fetchProblems":{"unreadable":0,"listingFailures":0}}`. Both must be 0. A
release fetched minutes after PIB posts it is retried once after 20 seconds; if
it still cannot be read it is reported as `FAILED read` and picked up by the
next run, since it is not on the site yet. A `FAILED listing` line means an
office's listing did not load: report it.

## 2. Original briefs: drafted, never published by the run

First list the day's CDSCO and FSSAI leads:

    npm run -s sources

It writes `scripts/sources/YYYY-MM-DD.json` with notices not seen before.
CDSCO and FSSAI are **leads for briefs only**: CDSCO's copyright policy forbids
reproduction without permission and FSSAI's pages contradict each other, so
never copy their text onto the site. Open the notice, write in our own words,
cite it, and save it as a draft like any other brief. Most CDSCO notices are
routine licensing paperwork; pick only items that matter to patients,
prescribers or the industry (drug alerts, bans, recalls, price or quality
rules, misleading-claim notices). FSSAI's site rarely updates its lists; an
empty FSSAI result is normal. A `failed` entry in the tally means the site
changed or was down: report it.

Two or three briefs a day, saved as private drafts for the managing editor to
read and publish in the newsroom (`/newsroom`).

- **Sources:** official and primary only: PIB releases from any ministry with a
  health angle, MoHFW, ICMR, CDSCO, NPPA, FSSAI, NHA, WHO India, gazette
  notifications, court orders, published datasets. Open every source and cite
  its direct https address. No news sites as a primary source.
- **What makes a brief worth writing:** it adds something the release does not:
  a comparison with the earlier notice or last year's figure, what changes for
  patients or providers, a deadline, who is affected. Record that in
  `contribution` and `contributionNote`; without them the page is not indexed.
- **Rules:** every number and claim must be in a cited source. No medical
  advice, no invented quotes, no speculation. Plain newspaper English, Indian
  conventions (crore, lakh, ₹, 9 November). 250 to 450 words. Skip a topic the
  site already covers: check `/latest` and the newsroom drafts first.
- **If nothing meets the bar, write fewer.** One good brief beats three thin
  ones; zero is acceptable and should be reported.

File: `scripts/drafts/YYYY-MM-DD.json`, an array shaped like
`scripts/drafts/2026-11-19.json`:

    type            "original_brief"
    slug            short, lowercase, hyphenated
    sectionSlug     public-health | policy | research | medicines-devices | healthcare-delivery
    headline        up to 200 characters, sentence case
    standfirst      up to 400 characters
    body            blocks: paragraph, heading, list (ordered, items), quote
    citations       url, label, publisherName; exactly one with isPrimary true
    contribution    prior_notice_comparison | dataset_analysis | on_record_interview | local_reporting
    contributionNote  one sentence on what the brief adds
    assistModel     the model that drafted it

Load them (drafts only; existing slugs are skipped):

    npm run drafts -- scripts/drafts/YYYY-MM-DD.json --as adonis.arun@gmail.com

Then commit the drafts file on `main` and push it: `git fetch origin && git push origin main`
(publisher's standing instruction, 26 November 2026: push every day without asking).
Never force-push. If `main` is behind or has diverged from `origin/main`, or the
push is refused, leave it and report the exact error. Pushing the file does not
publish the briefs: they stay private drafts until the managing editor publishes them.

## 3. Report

How many releases were published, by ministry; the headline of each brief
drafted; anything that failed or was skipped and why. Say plainly when PIB
issued nothing and when no brief was written.
