/**
 * Fictional demo stories and source cards for development and tests.
 * Everything goes through the real commands and the real intake path, so the
 * seeded site reflects what the platform would actually publish.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./client";
import type { DemoSeed } from "./seed";
import { createArticle, loadActor, patchArticle, performAction, setLead } from "@/core/articles";
import { signRequest } from "@/core/crypto";
import { processIngestEvent } from "@/core/ingest/process";
import { receiveEvent } from "@/core/ingest/receive";
import { articles, ingestEvents } from "./schema";
import { and, eq } from "drizzle-orm";

const p = (text: string) => ({ type: "paragraph", text });
const h = (text: string) => ({ type: "heading", text });

interface Story {
  slug: string;
  type?: string;
  headline: string;
  standfirst: string;
  section: string;
  state?: string;
  body: unknown[];
  citations: { url: string; label: string; publisherName: string; isPrimary?: boolean }[];
  contribution: string;
  contributionNote: string;
  /** Minutes before `now` that the story was published. */
  ago: number;
  clinical?: boolean;
}

const BULLETIN = "State Health Bulletin";
const KERALA = "Kerala Health Bulletin";

const STORIES: Story[] = [
  {
    slug: "district-reporting-calendar",
    headline: "What changed in the district reporting calendar",
    standfirst: "Our desk compares the new reporting dates with the previous district notice.",
    section: "policy",
    state: "karnataka",
    ago: 60,
    body: [
      h("What the notice changes"),
      p("The new notice revises the reporting calendar. The earlier circular provides the baseline for the dates compared in this report."),
      p("Three of the four quarterly windows keep their length. The second window now opens a week later and closes on the last working day of the month."),
      h("Who it affects"),
      { type: "list", ordered: false, items: ["District programme officers who file the quarterly return", "Block-level data managers who compile facility figures", "Teaching hospitals that report through the district office"] },
      h("What stays the same"),
      p("The format of the return and the officers responsible for signing it are unchanged. The notice does not alter the monthly facility summary."),
    ],
    citations: [
      { url: "https://health.example/notices/204", label: "District reporting calendar released", publisherName: BULLETIN, isPrimary: true },
      { url: "https://health.example/notices/173", label: "Previous district reporting circular", publisherName: BULLETIN },
    ],
    contribution: "prior_notice_comparison",
    contributionNote: "Checked each date in notice 204 against circular 173.",
  },
  {
    slug: "kerala-outpatient-timetable",
    headline: "Kerala clinics publish a new outpatient timetable",
    standfirst: "Evening hours are extended at family health centres in four districts, the bulletin shows.",
    section: "healthcare-delivery",
    state: "kerala",
    ago: 150,
    body: [
      p("Family health centres in four districts will keep outpatient desks open until 6 pm on weekdays under a timetable published this week."),
      p("We compared the new timetable with the one issued last quarter. The change applies to weekday evenings only. Weekend hours are the same as before."),
      { type: "quote", text: "The evening desk was the most common request in the last public consultation.", attribution: "District programme office, on the record" },
    ],
    citations: [{ url: "https://kerala-health.example/notices/31", label: "Outpatient timetable for family health centres", publisherName: KERALA, isPrimary: true }],
    contribution: "prior_notice_comparison",
    contributionNote: "Compared with last quarter's timetable; confirmed the scope with the district office.",
  },
  {
    slug: "district-plan-template-consultation",
    headline: "Consultation opens on district plan templates",
    standfirst: "Officials have three weeks to comment on a shorter planning format.",
    section: "policy",
    ago: 320,
    body: [
      p("A consultation window has opened on a revised template for annual district plans. Comments close in three weeks."),
      p("The draft cuts the template from eleven sections to seven. Our reading of both versions shows the budget annexure and the staffing table are merged, and the narrative summary is capped at two pages."),
    ],
    citations: [{ url: "https://health.example/notices/198", label: "Consultation on district plan templates", publisherName: BULLETIN, isPrimary: true }],
    contribution: "prior_notice_comparison",
    contributionNote: "Read the draft template against the current one, section by section.",
  },
  {
    slug: "bengaluru-hospital-board-schedule",
    headline: "Bengaluru hospital board publishes its meeting schedule",
    standfirst: "The teaching hospital's board will meet six times this year, with agendas posted a week ahead.",
    section: "healthcare-delivery",
    state: "karnataka",
    ago: 480,
    body: [
      p("The governing board of a Bengaluru teaching hospital has published its meeting schedule for the year, the first time it has done so in advance."),
      p("Six meetings are listed. Agendas will be posted seven days before each one, and minutes within a fortnight."),
    ],
    citations: [{ url: "https://health.example/notices/187", label: "Hospital board meeting schedule", publisherName: BULLETIN, isPrimary: true }],
    contribution: "local_reporting",
    contributionNote: "Confirmed the publication practice with the board secretariat.",
  },
  {
    slug: "journal-submission-window",
    type: "original_report",
    headline: "Journal sets a new submission window for district-level papers",
    standfirst: "The window opens next month and gives priority to work from outside metropolitan centres.",
    section: "research",
    ago: 700,
    body: [
      p("An Indian public health journal has announced a submission window reserved for papers based on district-level data."),
      p("Editors told us that manuscripts from institutions outside the largest cities will be reviewed first. The call does not change the journal's peer review process."),
    ],
    citations: [{ url: "https://health.example/notices/181", label: "Call for district-level papers", publisherName: BULLETIN, isPrimary: true }],
    contribution: "on_record_interview",
    contributionNote: "On-record conversation with the journal's managing editor.",
  },
  {
    slug: "device-procurement-workshop-dates",
    headline: "Tender notice lists dates for a device procurement workshop",
    standfirst: "Two sessions are planned for suppliers new to the state portal.",
    section: "medicines-devices",
    state: "tamil-nadu",
    ago: 900,
    body: [
      p("A tender notice sets out two workshop sessions for suppliers registering on the state procurement portal for the first time."),
      p("We checked the notice against last year's. The registration deadline moves forward by ten days and the document checklist is unchanged."),
    ],
    citations: [{ url: "https://health.example/notices/176", label: "Supplier workshop notice", publisherName: BULLETIN, isPrimary: true }],
    contribution: "prior_notice_comparison",
    contributionNote: "Compared deadlines and checklist with the previous year's notice.",
  },
  {
    slug: "dengue-bulletin-three-districts",
    type: "original_report",
    headline: "Dengue cases reported in three Karnataka districts, bulletin shows",
    standfirst: "The weekly bulletin lists confirmed cases by district. We set them beside the same week last year.",
    section: "public-health",
    state: "karnataka",
    ago: 1100,
    clinical: true,
    body: [
      p("The state's weekly bulletin reports confirmed dengue cases in three districts. The figures are those published by the department and are attributed to it."),
      p("We compared the bulletin with the same reporting week last year. Two districts report more confirmed cases and one reports fewer. The bulletin does not give rates per population, so the districts cannot be ranked against each other."),
      p("The bulletin makes no change to public guidance. Readers with symptoms should follow the advice of a qualified clinician."),
    ],
    citations: [
      { url: "https://health.example/notices/201", label: "Weekly disease bulletin", publisherName: BULLETIN, isPrimary: true },
      { url: "https://health.example/notices/96", label: "Weekly disease bulletin, same week last year", publisherName: BULLETIN },
    ],
    contribution: "dataset_analysis",
    contributionNote: "Compared district counts across the two bulletins; counts only, no rates.",
  },
];

const CARDS: { producer: "a" | "b"; source: string; ext: string; url: string; title: string; ago: number }[] = [
  { producer: "a", source: "state-bulletin-demo", ext: "notice-204", url: "https://health.example/notices/204", title: "District reporting calendar released", ago: 126 },
  { producer: "a", source: "kerala-bulletin-demo", ext: "kl-31", url: "https://kerala-health.example/notices/31", title: "Outpatient timetable for family health centres", ago: 200 },
  { producer: "a", source: "state-bulletin-demo", ext: "notice-206", url: "https://health.example/notices/206", title: "Appointment of district programme officers notified", ago: 30 },
  { producer: "b", source: "partner-demo", ext: "wire-12", url: "https://partner.example/wire/12", title: "Community clinic timetable published", ago: 400 },
  { producer: "a", source: "kerala-bulletin-demo", ext: "kl-33", url: "https://kerala-health.example/notices/33", title: "Meeting notice for district officers", ago: 620 },
];

export async function seedDemoContent(db: Db, seed: DemoSeed, now: Date): Promise<void> {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const reporter = await loadActor(db, seed.people.reporter);
  const editor = await loadActor(db, seed.people.editor);
  const reviewer = await loadActor(db, seed.people.reviewer);
  const key = () => `seed-${randomUUID()}`;

  for (const c of CARDS) {
    const producer = seed.producers[c.producer];
    const at = ago(c.ago);
    const event = { schema_version: 1, event_id: randomUUID(), source_id: c.source, external_id: c.ext, revision: 1, event_type: "item.upsert", source_url: c.url, source_title: c.title, language: "en", source_published_at: ago(c.ago + 6).toISOString(), observed_at: at.toISOString() };
    const raw = Buffer.from(JSON.stringify(event));
    const timestamp = String(Math.floor(at.getTime() / 1000));
    const res = await receiveEvent(db, { producerKey: producer.keyId, timestamp, signature: signRequest(producer.secret, timestamp, event.event_id, raw), idempotencyKey: event.event_id }, raw, at);
    // Already seeded on an earlier run: leave the existing item alone.
    if (res.status === 409) continue;
    if (res.status !== 202) throw new Error(`seed card ${c.ext} rejected: ${JSON.stringify(res.body)}`);
    const [row] = await db.select().from(ingestEvents).where(and(eq(ingestEvents.producerId, producer.id), eq(ingestEvents.eventId, event.event_id)));
    await processIngestEvent(db, row!.id, at);
  }

  let leadId: string | undefined;
  for (const s of STORIES) {
    if ((await db.select({ id: articles.id }).from(articles).where(eq(articles.slug, s.slug))).length > 0) continue;
    const at = ago(s.ago);
    const created = await createArticle(
      db,
      reporter,
      { type: s.type ?? "original_brief", slug: s.slug, headline: s.headline, standfirst: s.standfirst, body: s.body, sectionSlug: s.section, termSlugs: s.state ? [{ kind: "state", slug: s.state }] : [], citations: s.citations, contribution: s.contribution, contributionNote: s.contributionNote },
      ago(s.ago + 30),
    );
    let v = (await performAction(db, reporter, created.id, { action: "submit", expectedVersion: created.version, idempotencyKey: key() }, ago(s.ago + 20))).version;
    v = (await performAction(db, editor, created.id, { action: "approve-editorial", expectedVersion: v, idempotencyKey: key() }, ago(s.ago + 10))).version;
    if (s.clinical) v = (await performAction(db, reviewer, created.id, { action: "approve-medical", expectedVersion: v, idempotencyKey: key(), evidence: "Checked district counts against both bulletins." }, ago(s.ago + 5))).version;
    v = (await performAction(db, editor, created.id, { action: "publish", expectedVersion: v, idempotencyKey: key() }, at)).version;
    if (s.slug === "district-reporting-calendar") {
      leadId = created.id;
      // A published correction, so the article shows a genuine "Updated" time and note.
      const edited = await patchArticle(db, reporter, created.id, { expectedVersion: v, correctionNote: "An earlier version gave the wrong closing day for the second reporting window." }, ago(20));
      let cv = (await performAction(db, reporter, created.id, { action: "submit", expectedVersion: edited.version, idempotencyKey: key() }, ago(18))).version;
      cv = (await performAction(db, editor, created.id, { action: "approve-editorial", expectedVersion: cv, idempotencyKey: key() }, ago(16))).version;
      await performAction(db, editor, created.id, { action: "correct", expectedVersion: cv, idempotencyKey: key() }, ago(15));
    }
  }
  if (leadId) await setLead(db, editor, leadId, { rank: 10, until: null, reason: "Demo lead" });
}
