# Scraper handover

This covers the "real scraper" that `docs/DECISIONS.md` lists under "Not software, and blocking launch".

- Planned 25 November 2026; built and dry-run 26 November 2026.
- The scraper is a **producer**. It fetches the sources below and posts signed v1 events to `POST /api/v1/ingest/events`.
- It never touches the database and makes no publishing decisions. Rights, risk and automation stay with the platform.
- How to run it: [scraper/README.md](../scraper/README.md).

## 0. Status, 26 November 2026

**Built:** `scraper/` with `npm run scrape -- dry-run | once | daemon | receipts | status`, plus `npm run test:scraper`.

**Tests**
- 37 scraper unit tests, no database.
- 4 integration tests in `tests/scraper-intake.test.ts`. They run the scraper against the real `receiveEvent`, the worker and `getReceipt`, and cover:
  - a link-only card published (`CARD_PUBLISHED`);
  - a revision when a headline changes;
  - recovery from a lost scraper database by re-issuing past the platform's revisions;
  - a host the source register does not approve (`URL_NOT_ALLOWED`, parked and alerted);
  - an unregistered source (`SOURCE_NOT_AUTHORIZED`, held in the outbox).
- `npm test`: 67 of 67 pass. `npm run typecheck` is clean.

**Live dry run**
- 23 of 23 enabled sources answered; 448 events.
- Each event was validated against `src/core/ingest/contract.ts`.
- Nothing was sent or stored. The events are in `scraper/out/` (git-ignored) and were handed to the developer as files.

**Changes the live run forced on the source list**

| Source | What happened | Now |
|---|---|---|
| Business Standard, News18, Firstpost, Medical Dialogues | Each answers 403 to the `IndiaHealthNewsBot` User-Agent and 200 to a browser one. robots.txt does not name the bot, so this is a firewall rule against declared bots. | Off, `requires: bot_allowlisting`. Not worked around. |
| Becker's Hospital Review | robots.txt has two `*` groups. Merged per RFC 9309, they disallow `/feed/`. (The first probe could not read the file and wrongly treated it as allowed.) | Not carried |
| Times of India | Lists no health feed; `2886704` is the whole Life & Style section | Health keyword filter instead of a path rule |
| WHO | The news feed's newest item is from 10 October, so nothing falls inside its 30-day window | Kept on; the stale-feed alert will fire |

**Other notes**
- The keyword filter for general feeds was tuned on the live run. Precision went from about 3 in 4 to about 9 in 10.
- Node's `fetch` reaches India Today and `mohfw.gov.in` without trouble. The TLS-chain problem seen on 25 November affected Python only.

## 1. Issues resolved

| Question | Resolution |
|---|---|
| Where the site's code and database live | This repo and its Neon database. The scraper only talks to the intake API with its own producer key. |
| Should source updates publish automatically or wait for an editor? | The platform decides per source: grant in force, source status, per-source automation switch and the risk screen (PUB-01). The scraper sends every item that passes its filters. |
| Sites that block automated clients outright (ThePrint, Zee, Telegraph, The Week, Reuters) | Not fetched. Reuters is licence-only (Reuters Connect). |
| Sites that block declared bots (Business Standard, News18, Firstpost, Medical Dialogues) | Off until the publisher allowlists `IndiaHealthNewsBot`. Not worked around. |
| Sites whose robots.txt or terms forbid scraping or commercial use (BBC, NYT, Al Jazeera, MedPage Today, Guardian, and Becker's feed) | Off, or not carried. One switches on only after written permission is on record. |
| Feeds that carry full article text | `body_text` is never sent. No full-text grant exists, and intake would discard it anyway. |
| Clustering and section tagging | Platform side. Intake suggests clusters, and a card takes its section from the source's default section. |
| PIB | Not in the scraper. `npm run pib` already imports it in full. |
| Language | TypeScript, inside this repo. The scraper imports the contract schema, `signRequest` and `checkSourceUrl` from `src/core`, so it cannot drift from the platform. |

## 2. What the scraper does

```
scraper/sources.json -> robots.txt check -> conditional GET (RSS / Atom / Google News sitemap)
  -> parse -> clean URL, approved host and path, health filter, age limit
  -> v1 event, validated with the platform's zod schema
  -> SQLite outbox (event_id, revision, exact bytes)
  -> HMAC-signed POST -> receipt polling -> alerts
```

### Mapping to the v1 contract

| Field | Value |
|---|---|
| `source_id` | Manifest slug. Must equal the slug in the source register. |
| `external_id` | Feed `guid` (cleaned if it is a URL), otherwise the cleaned article URL. Hashed if longer than 300 characters. |
| `revision` | 1, then +1 when URL, redirect target, title, excerpt, dates or author change. |
| `event_id` | New UUID per revision, stored with the exact body bytes. A retry resends those bytes. |
| `source_url` | Article URL, https. `utm_*`, `src=rss`, `#publisher=…` and similar are stripped. |
| `resolved_url` | Only for redirecting links (CDC), read from the `Location` header without fetching the target. |
| `source_title` | Feed title, entities decoded, at most 500 characters. |
| `language` | `en` |
| `source_published_at` | ISO 8601 (UTC). When the feed gives no date, or a date without a zone and no zone in the manifest: `null`, with the reason in `source_published_at_reason`. |
| `source_updated_at`, `source_author` | When the feed has them. Bare e-mail authors are dropped. |
| `excerpt` | Feed teaser as plain text, at most 300 characters. Intake keeps it only if the grant allows excerpts. |
| `adapter_version` | `rss@1.0.0` or `news-sitemap@1.0.0` |
| `body_text`, `media_candidates`, `item.withdraw` | Not sent in v1 |

### Intake answers

| Answer | Scraper action |
|---|---|
| 202 / 200 | Store the receipt; poll it until it settles |
| 5xx / network | Retry the same bytes with backoff (1 min doubling to 1 h); alert after 5 attempts |
| 401 `TIMESTAMP_SKEW` | Re-sign once; a second one stops the run (clock wrong) |
| 401 other | Stop the run and alert (bad key) |
| 429 | Wait for `Retry-After` and stop the run |
| 409 `REVISION_CONFLICT` | Re-issue the same content as the next revision |
| 403 `SOURCE_*` | Hold that source's events in the outbox, retry every 30 minutes, alert |
| 422 / 400 | Park the event and alert (`url_not_allowed` when the host is missing from the register) |

## 3. Source manifest

`scraper/sources.json` is the registration sheet. Each entry has:
- slug, display and legal names (to be confirmed), family and a suggested default section;
- approved hosts with path prefixes.

### On (23)

| Group | Sources |
|---|---|
| Health feeds, India | `the-hindu`, `times-of-india` (health filter), `hindustan-times`, `indian-express`, `ndtv` (NDTV's own FeedBurner feed), `abp-live`, `ethealthworld`, `express-healthcare`, `medindia` (no dates in feed) |
| Health feeds, international | `who` (last 30 days), `cdc` (redirects resolved), `stat`, `kff-health-news`, `healio`, `fierce-healthcare` (dates read as US Eastern), `medscape` |
| General feeds with the health filter | `india-today`, `mint`, `scroll` |
| Google News sitemaps with the health filter | `deccan-herald`, `times-now`, `outlook-india`, `down-to-earth` |

### Off (17)

| Reason | Sources |
|---|---|
| Wave 2: listing adapters, not built | `mohfw`, `icmr`, `dd-news`, `all-india-radio`, `bw-healthcare`, `pharmabiz` |
| Wave 2: Crossref metadata adapter, not built | `lancet`, `nejm` |
| Need written permission | `bbc-health`, `nyt-health`, `al-jazeera`, `medpage-today`, `guardian-health` |
| Need the publisher to allowlist the bot | `business-standard`, `news18`, `firstpost`, `medical-dialogues` |

### Not carried (15)

| Reason | Sources |
|---|---|
| Already imported by `npm run pib` | PIB |
| Block automated clients | ThePrint, Zee News, The Telegraph, The Week, Reuters |
| robots.txt disallows the feed | Becker's Hospital Review |
| Not news publishers | Practo, Tata 1mg, Lybrate |
| Dead or no feed | CNN Health, Medical News Today, Healthline, Harvard Health |
| Covered by `who` | WHO India |

Total: 23 + 17 + 15 = 55.

## 4. What the platform side needs to provide

1. **Producer provisioning.** Built 27 November: `npm run scraper-setup -- producer | assign | rotate | list` (see [scraper/README.md](../scraper/README.md#platform-setup)).
   - Creates producer `ihn-scraper`, stores its secret encrypted and assigns the manifest's sources.
   - Shows the secret once, or writes it straight into an env file with `--write-env`.
   - Rotation keeps the old secret valid for an overlap (24 hours by default).
2. **Source registration.** Built 27 November: `npm run scraper-setup -- sources` registers the 23 enabled sources from `scraper/sources.json` and puts them on trial (`under_review`), so the trial runs without publishing anything.
3. **Grants and automation (publisher).** Every source starts at grant `unknown`, so every item is held. Cards appear once the managing editor:
   - records a `link_only` grant for each accepted source;
   - enables the source;
   - switches on `source_card` automation, if cards should go live without an editor.
4. **Risk screen on link-only cards (decision).** `assessRisk` over the 448 dry-run events:

   | Route | Events | Share |
   |---|---|---|
   | Routine | 281 | 63% |
   | Clinical | 148 | 33% |
   | Sensitive | 19 | 4% |

   - About 37% would be held, matching the 36% measured on 25 November.
   - Any flag blocks even a headline-and-link card.
   - Options: keep that, relax the screen for `link_only` cards, or record a standing override as was done for PIB.
5. **Optional, later.** Contract v2 could add `section_hint` and `state_hints`, so a card from a general outlet does not take the source's single default section.

## 5. Handover steps

1. **Build.** Done 26 November, on branch `scraper-handover`.
2. **Dry run.** Done 26 November: 448 events from 23 sources, handed over as JSONL files.
3. **Local end to end.** Covered by `tests/scraper-intake.test.ts`. A manual check is still possible:
   - `npm run dev` with the demo seed;
   - `PRODUCER_KEY` / `PRODUCER_SECRET` from `npm run db:seed -- --demo`;
   - `npm run scrape -- once --source <slug>` against a demo-registered source.
4. **Production trial.**
   - With the site's `DATABASE_URL` and `INGEST_SECRET_KEY` in `.env.local`: `npm run scraper-setup -- sources --as <managing editor>`, then `npm run scraper-setup -- producer --as <managing editor> --write-env .env.local`.
   - Set `INGEST_BASE_URL=https://www.indiahealthnews.com`, run `npm run scrape -- once`, then `npm run scrape -- daemon` for 48 hours. Nothing goes public.
   - Pass: zero `url_not_allowed` and `receipt_failed` alerts; the held reasons are reviewed.
5. **Go live.** Grants and automation per section 4, item 3.
6. **Hosting.** The daemon needs a persistent disk for `SCRAPER_DB` and a process supervisor. A small always-on VM or container is the simplest; Vercel functions and stateless CI runners are not a fit. Who hosts it is still open.

## 6. Still open

- Where the scraper runs, and who receives its alerts (`SCRAPER_ALERT_WEBHOOK`).
- Whether to ask the four bot-blocking publishers to allowlist `IndiaHealthNewsBot`, and the five permission-gated ones for permission.
- The risk-screen decision in section 4, item 4.
- Wave 2 adapters: government listing pages and Crossref.
