# Scraper

The producer for `POST /api/v1/ingest/events`.

- It reads publishers' RSS feeds and Google News sitemaps and posts one signed v1 event per item.
- It never touches the database and decides nothing about publishing. Grants, the risk screen and automation switches stay with the platform.
- The plan, the source decisions and what the platform side must provide are in [docs/SCRAPER-HANDOVER.md](../docs/SCRAPER-HANDOVER.md).

## Commands

```bash
npm run scrape -- dry-run                  # fetch every enabled source, write events to scraper/out/<time>/, send nothing
npm run scrape -- dry-run --source who,cdc
npm run scrape -- once --no-send           # fill the outbox without sending (no producer key needed)
npm run scrape -- once                     # fetch due sources, send, poll receipts, print a table
npm run scrape -- once --force             # ignore poll intervals and backoff
npm run scrape -- daemon                   # every minute; each source on its own interval (15 min feeds, 30 min sitemaps)
npm run scrape -- receipts                 # re-poll receipts still accepted or processing
npm run scrape -- status                   # feeds, outbox counts, recent alerts
npm run test:scraper                       # unit tests, no database
```

`tests/scraper-intake.test.ts` runs with `npm test` and drives the scraper against the platform's real intake and worker.

## Configuration

Set these in `.env.local` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `INGEST_BASE_URL` | `http://localhost:3000` | Platform to post to |
| `PRODUCER_KEY`, `PRODUCER_SECRET` | none | This producer's intake credentials, issued by the platform |
| `SCRAPER_DB` | `scraper/data/scraper.db` | SQLite outbox and feed state. **Keep it.** It holds the revision numbers already sent. If it is lost, the scraper recovers through `REVISION_CONFLICT` re-issues, but the next run re-sends every item. |
| `SCRAPER_MAX_AGE_DAYS` | 7 | Items older than this are not sent. A source's `maxAgeDays` overrides it. |
| `SCRAPER_SEND_PER_MINUTE` | 120 | Intake request pace. The platform allows 600 a minute per producer. |
| `SCRAPER_ALERT_WEBHOOK` | none | Receives `{"text": …}` for each new alert (works with a Slack incoming webhook) |
| `SCRAPER_USER_AGENT` | `IndiaHealthNewsBot/1.0 (+https://www.indiahealthnews.com/about)` | Keep the `IndiaHealthNewsBot` token: robots.txt rules match on it |

Needs Node 22.13 or later for `node:sqlite`.

## How it behaves

**Fetching**
- robots.txt is checked for every URL (RFC 9309).
- Requests use conditional GET.
- Each feed host gets one request at a time, with several hosts in parallel.
- 401/403 and 429 from a publisher are reported and backed off. They are never worked around.

**Events**
- `external_id` is the feed guid, or the cleaned URL when there is none.
- Changed content gets the next `revision`.
- Every event is checked against `src/core/ingest/contract.ts` before it is stored.
- The exact bytes are kept, so a retry is an idempotent replay.
- `body_text` and `media_candidates` are never sent.

**Intake answers**

| Answer | What the scraper does |
|---|---|
| 5xx / network | Retry the same bytes with backoff |
| `TIMESTAMP_SKEW` | Re-sign once |
| 429 | Wait for `Retry-After` |
| `REVISION_CONFLICT` | Re-issue as the next revision |
| `SOURCE_*` 403 | Keep the events and alert |
| 422 | Park the event and alert |
| `SIGNATURE_INVALID` | Stop the run and alert |

**Alerts**
- Each alert is raised at most once a day per source and kind.
- Kinds: `robots`, `blocked`, `rate_limited`, `drift` (a 200 response that is not a feed, or has no items), `stale_feed`, `network` (three failures in a row), `off_host`, `invalid_event`, `source_refused`, `url_not_allowed`, `event_parked`, `intake_auth`, `receipt_failed`.

## Platform setup

`npm run scraper-setup` registers the sources and issues the producer key. It writes to the site's database, so it needs `DATABASE_URL` and the same `INGEST_SECRET_KEY` the site runs with. `--as` is a staff account with the managing editor or administrator role.

```bash
npm run scraper-setup -- sources  --as you@example.com                          # register every enabled source, on trial (under review)
npm run scraper-setup -- producer --as you@example.com --write-env .env.local   # key "ihn-scraper" for those sources; writes PRODUCER_KEY/SECRET, never prints the secret
npm run scraper-setup -- assign   --as you@example.com --source new-slug        # after adding a source to sources.json and registering it
npm run scraper-setup -- rotate   --as you@example.com --write-env .env.local   # new secret; the old one keeps working for 24 hours (--overlap-hours)
npm run scraper-setup -- list                                                   # producers, their sources, secret validity
```

- A source already in the register is never changed; `sources` reports it, and flags it when its hosts differ from the manifest.
- Without `--write-env`, `producer` and `rotate` print the secret once.
- Each action is in the audit trail. Grants and automation are still recorded in the newsroom.

## Adding or changing a source

1. Edit `scraper/sources.json`. `hosts` must equal the approved hosts recorded in the source register, or intake answers `URL_NOT_ALLOWED`.
2. Run `npm run scrape -- dry-run --source <slug>` and read the JSONL it writes.
3. Run `npm run test:scraper`. The manifest test counts sources, so update it when the list changes.
4. Register it and give the producer access: `npm run scraper-setup -- sources --as … --source <slug>`, then `assign` with the same `--source`.

A source with `"enabled": false` is never fetched, not even by a dry run. `requires` says why it is off:
- `written_permission`: the publisher's terms forbid automated or commercial use.
- `bot_allowlisting`: the publisher's firewall refuses declared bots.
