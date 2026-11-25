# Scraper handover plan

Prepared 25 November 2026. It covers the "real scraper" listed under "Not software, and blocking launch" in `docs/DECISIONS.md`.

- The scraper is a **producer**. It fetches the sources below and posts signed v1 events to `POST /api/v1/ingest/events`.
- It never touches the database and makes no publishing decisions. Rights, risk and automation stay with the platform.
- Every source in this plan was probed on 25 November 2026: robots.txt, the section page, RSS feeds and news sitemaps.

## 1. Issues resolved since the first scraping plan

| Earlier open question | Resolution |
|---|---|
| Where the site's code and database live | This repo and its Neon database. The scraper only talks to the intake API with its own producer key. |
| Should source updates publish automatically or wait for an editor? | The platform decides per source: grant in force, source status, per-source automation switch and the risk screen (PUB-01). The scraper sends every item that passes its health filter. |
| Blocked sites (ThePrint, Zee, Telegraph, The Week, Reuters) | Not fetched. Each answers 401/403 to automated clients, and the scraper does not work around blocks. Reuters is licence-only (Reuters Connect). |
| Sites whose robots.txt forbids scraping or commercial use (BBC, NYT, Al Jazeera, MedPage Today, Guardian) | In the manifest but **off**. One switches on only after the publisher records written permission as a grant. |
| Feeds that carry full article text | `body_text` is never sent. No full-text grant exists, and intake would discard it anyway (decision 2, phases 3 to 5). |
| Clustering and section tagging | Platform side. Intake already suggests clusters, and a card takes its section from the source's default section. The scraper does neither. |
| PIB | Not in the scraper. `npm run pib` already imports it in full, and a second path would create duplicates. |
| Language | TypeScript, inside this repo. The scraper imports `src/core/ingest/contract.ts` and `signRequest` from `src/core/crypto.ts`, so it cannot drift from the contract. |

## 2. What the scraper does

```
manifest (scraper/sources.json)
  -> fetch: RSS / news sitemap / listing page
     (robots.txt, conditional GET, 1 request per host per run)
  -> parse and filter: health relevance, host and path allow-list, strip tracking
  -> map to a v1 event and validate with the repo's own zod schema
  -> local outbox (SQLite): event_id, revision and exact body bytes kept until a receipt
  -> sign (HMAC) and POST; poll receipts; log held/applied
```

### Mapping to the v1 contract

| Field | Value |
|---|---|
| `source_id` | Manifest slug. Must equal the slug registered in the source register. |
| `external_id` | Feed `guid` when it is stable, otherwise the cleaned article URL. |
| `revision` | 1, then +1 when the title, excerpt, URL or update time changes. Kept in the outbox, so a changed item never reuses a revision (`REVISION_CONFLICT`). |
| `event_id` | New UUID per (source, item, revision), stored with the exact body bytes. A retry resends the same bytes, so no `EVENT_ID_REUSED`. |
| `source_url` | Article URL, https. Strips `utm_*`, `src=rss`, `#publisher=…` and similar. It must sit on a registered host and path. |
| `source_title` | Feed title, entities decoded, at most 500 characters. |
| `language` | `en` |
| `source_published_at` | Feed date as ISO 8601 with offset. If the feed has none: `null`, plus `source_published_at_reason: "feed gives no publication time"`. |
| `source_updated_at`, `source_author` | When the feed has them. |
| `excerpt` | Feed teaser as plain text, cut at about 300 characters on a word boundary. Intake keeps it only if the grant allows excerpts. |
| `resolved_url` | Only where the feed links through a redirect (CDC). |
| `adapter_version` | For example `rss@1.0.0`, `news-sitemap@1.0.0`. |
| `body_text`, `media_candidates` | Not sent in v1. No full-text or image grants exist, and there is no media pipeline. |
| `item.withdraw` | Not in v1. A feed dropping an item does not mean it was withdrawn. |

### Responses

- **202 / 200**: store the receipt.
- **401 `TIMESTAMP_SKEW`**: re-sign the same bytes with a fresh timestamp.
- **409 `REVISION_CONFLICT`**: bump the revision and send a new event.
- **422 `URL_NOT_ALLOWED`**: park the item and alert, because a host is missing from the register.
- **403 `SOURCE_*`**: stop that source and alert.
- **429**: wait for `Retry-After`.
- **5xx / network**: retry the same bytes with backoff.

### Fetching rules

These are assigned to the scraper by the SRS (SRC-03, ING-03).

- Honest User-Agent naming the site and a contact page.
- robots.txt checked per URL.
- ETag / If-Modified-Since on every feed.
- At most one request per host per run. Feeds every 15 minutes, news sitemaps every 30.
- 45-second timeouts, and backoff on 403/429 from a source.
- **Stale-feed alert**: the newest item is older than 7 days.
- **Parser-drift alert**: a 200 response yields 0 items. This covers the two AT-08 cases that DECISIONS.md left to the scraper.

### Commands

```
npm run scrape -- dry-run [--source slug]   fetch and write events to scraper/out/*.jsonl, send nothing
npm run scrape -- once                      one full pass, send, print a tally per source
npm run scrape -- daemon                    run on the schedule above
npm run scrape -- receipts                  re-poll receipts that are still accepted/processing
```

`dry-run` gives the developer real event files to inspect before any key exists.

## 3. Source manifest

Hosts and paths come from the links each feed actually carries. They are what the source register needs, or intake answers `URL_NOT_ALLOWED`.

Family (suggested; the managing editor decides): **A** = `national_authority`, **C** = `independent_commercial`, **P** = `research_professional`.

### Wave 1: on at launch (28)

Health-specific feeds:

| Slug | Feed | Hosts / path | Fam. | Notes |
|---|---|---|---|---|
| `the-hindu` | thehindu.com/sci-tech/health/feeder/default.rss | www.thehindu.com | C | |
| `times-of-india` | timesofindia.indiatimes.com/rssfeeds/2886704.cms | timesofindia.indiatimes.com `/life-style/health-fitness` | C | The feed mixes in travel and relationships, so keep only that path |
| `hindustan-times` | hindustantimes.com/feeds/rss/lifestyle/health/rssfeed.xml | www.hindustantimes.com `/lifestyle/health` | C | |
| `indian-express` | indianexpress.com/section/lifestyle/health/feed/ | indianexpress.com `/article/lifestyle/health` | C | Full text in feed, not sent |
| `ndtv` | feeds.feedburner.com/ndtvhealth-latest | www.ndtv.com `/health` | C | ndtv.com itself returns 403; this is NDTV's own feed. Strip `#publisher` |
| `business-standard` | business-standard.com/rss/health-185.rss | www.business-standard.com | C | |
| `news18` | news18.com/commonfeeds/v1/eng/rss/lifestyle/health-and-fitness.xml | www.news18.com `/lifestyle` | C | Drop `/photogallery` items (55 of 200) |
| `firstpost` | firstpost.com/commonfeeds/v1/mfp/rss/health.xml | www.firstpost.com | C | |
| `abp-live` | news.abplive.com/health/feed | news.abplive.com | C | |
| `ethealthworld` | health.economictimes.indiatimes.com/rss/topstories | health.economictimes.indiatimes.com | P | Intermittent timeouts; retry next run |
| `medical-dialogues` | medicaldialogues.in/google_feeds.xml | medicaldialogues.in | P | `/feed` is stale since May 2026 |
| `express-healthcare` | expresshealthcare.in/feed/ | www.expresshealthcare.in | P | |
| `medindia` | medindia.net/rss2.0/latest-on-medindia.xml | www.medindia.net | C | No dates in feed, so `source_published_at: null` with reason |
| `who` | who.int/rss-feeds/news-english.xml | www.who.int `/news` | A | Items are unsorted and go back to 2018; send the last 30 days only |
| `cdc` | tools.cdc.gov/podcasts/feed.asp?feedid=183 | tools.cdc.gov, www.cdc.gov | A | Links are redirects; send `resolved_url` |
| `stat` | statnews.com/feed/ | www.statnews.com | C | |
| `kff-health-news` | kffhealthnews.org/feed/ | kffhealthnews.org | C | Offers free republishing: a candidate for a full-text grant later |
| `healio` | healio.com/sws/feed/news/all | www.healio.com `/news` | P | |
| `fierce-healthcare` | fiercehealthcare.com/rss/xml | www.fiercehealthcare.com | P | |
| `beckers` | beckershospitalreview.com/feed/ | www.beckershospitalreview.com | P | Site returns 403; the feed works |
| `medscape` | medscape.com/cx/rssfeeds/2700.xml | www.medscape.com `/viewarticle` | P | Strip `src=rss` |

General feeds with a health filter:

| Slug | Feed | Hosts / path | Fam. | Notes |
|---|---|---|---|---|
| `india-today` | indiatoday.in/rss/home | www.indiatoday.in | C | No health-only feed; filter on `/health` or keywords. Drop `aajtak.in` links. Incomplete TLS chain: ship the intermediate certificate |
| `mint` | livemint.com/rss/science | www.livemint.com `/science` | C | Keyword filter |
| `scroll` | feeds.feedburner.com/ScrollinArticles.rss | scroll.in `/article`, `/latest` | C | All sections; keyword filter |

Google News sitemaps (no feed):

| Slug | Sitemap | Hosts / path | Fam. | Notes |
|---|---|---|---|---|
| `deccan-herald` | deccanherald.com/news_sitemap.xml | www.deccanherald.com | C | ~480 URLs, ~13 health; title and path filter |
| `times-now` | timesnownews.com/google-news-sitemap-en.xml | www.timesnownews.com | C | ~470 URLs, ~15 health |
| `outlook-india` | outlookindia.com/oisitemap-news.xml | www.outlookindia.com | C | Health is not in the URLs, so filter on `news:title` |
| `down-to-earth` | downtoearth.org.in/news_sitemap.xml | www.downtoearth.org.in | C | `/rss/health` returns HTML, not a feed |

### Wave 2: after wave 1 is stable (8)

- **Listing-page adapters** (headline, link and date only): `mohfw` (use `www.`; the bare domain's TLS chain fails), `icmr` (`/press-releases`), `dd-news`, `all-india-radio`, `bw-healthcare`, `pharmabiz`.
- **Journal metadata through Crossref** (`api.crossref.org/journals/{ISSN}/works`): `lancet`, `nejm`. Their own feeds are disallowed in robots.txt.

### Off until the publisher records permission (5)

`bbc-health`, `nyt-health`, `al-jazeera`, `medpage-today`, `guardian-health`. The feeds work, but their robots.txt says no scraping, personal or non-commercial use only, or commercial use under licence.

### Not carried (14)

| Reason | Sources |
|---|---|
| Already imported by `npm run pib` | PIB |
| Block automated clients | ThePrint, Zee News, The Telegraph, The Week, Reuters |
| Not news publishers; terms restrict scraping | Practo, Tata 1mg, Lybrate |
| No working feed; mostly evergreen content | CNN Health (feed dead since November 2022), Medical News Today, Healthline, Harvard Health |
| Covered elsewhere | WHO India comes through the `who` feed |

## 4. What the platform side needs to provide

1. **Producer provisioning (blocking).** Only the demo seed creates producers. Production needs a command that:
   - creates a producer and prints its key id and secret once;
   - assigns sources to it (`producer_sources`);
   - rotates the secret (the `valid_from` / `valid_until` columns already allow overlap).
2. **Source registration (blocking).** The 28 wave-1 sources need slug, names, family and the hosts/paths above. The newsroom creates sources one at a time, so a loader that reads `scraper/sources.json` would save the typing. Sources can stay `proposed` or `under_review`: intake accepts and holds their events, so the trial below publishes nothing.
3. **Grants and automation (publisher).** Every source starts at grant `unknown`, so every item is held. Cards appear once the managing editor:
   - records a `link_only` grant for each source the publisher accepts;
   - enables the source;
   - switches on `source_card` automation, if cards should go live without an editor.
4. **Risk screen on link-only cards (decision).** Run over 1,033 live items from 16 wave-1 feeds on 25 November, `assessRisk` routed:

   | Route | Items | Share |
   |---|---|---|
   | Routine | 666 | 64% |
   | Clinical | 319 | 31% |
   | Sensitive | 48 | 5% |

   - Most common flags: named disease 170, treatment 91, research result 89.
   - Any flag blocks a card, even a headline-and-link card. At this rate an editor clears roughly a third of all items by hand.
   - The options: keep that, relax the screen for `link_only` cards, or record a standing override as was done for PIB.
5. **Optional, later.** Contract v2 could add `section_hint` and `state_hints`, so a card from a general outlet does not take the source's single default section.

## 5. Handover steps

1. **Build.** The scraper goes under `scraper/` on a branch with `npm run scrape`. Its tests run on recorded feed files and cover parser drift, source 429, revision bumps, retries with identical bytes and skew re-signing. Review is a PR into `main`.
2. **Dry run.** `npm run scrape -- dry-run` writes a day of real events to JSONL for the developer to inspect. This is the first data handover and needs no key.
3. **Local end to end.** Platform on the Docker test database with the demo seed; the scraper posts to `localhost:3000`; receipts end `held` or `applied`.
4. **Production trial.** After items 1 and 2 of section 4: wave-1 sources `under_review`, the scraper posts for 48 hours, nothing goes public. Pass: zero `URL_NOT_ALLOWED` and zero failed receipts; the held reasons are reviewed.
5. **Go live.** The publisher records grants and switches on automation per section 4, item 3.
6. **Hosting.** The scraper needs a schedule and a persistent disk for its outbox, so Vercel functions and stateless CI runners are a poor fit. A small always-on VM or container is the simplest. Who hosts it is still open.

## 6. Still open

- Where the scraper runs, and who receives its alerts.
- Whether the publisher wants permission requests sent to the five "off" sources and to the blocked ones.
- The risk-screen decision in section 4, item 4.
