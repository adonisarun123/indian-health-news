/**
 * First versions of the policy pages. The wording describes what the platform
 * actually does. Facts about the publisher are placeholders filled from
 * settings. Privacy, terms and complaints are drafts for the publisher's
 * adviser to review: they are not legal advice.
 */
import type { Db } from "./client";
import type { Block } from "@/core/articles";
import { pageExists, savePage } from "@/core/settings";

const p = (text: string): Block => ({ type: "paragraph", text });
const h = (text: string): Block => ({ type: "heading", text });
const ul = (...items: string[]): Block => ({ type: "list", ordered: false, items });

const PAGES: { slug: string; title: string; description: string; body: Block[] }[] = [
  {
    slug: "about",
    title: "About",
    description: "Who publishes this site, how it is funded and how it works.",
    body: [
      p("This site follows health developments across India. For each one we show who reported it and link to the original source, so you can check it yourself in one tap."),
      h("Who publishes it"),
      p("The site is published by {{legal_name}}, {{registered_address}}."),
      p("{{ownership_funding}}"),
      h("What you will find here"),
      ul(
        "Our reports. Written by a named reporter, approved by an editor and linked to at least one original source.",
        "Source updates. Labelled cards that name another publisher and open that publisher's own page. We do not present their work as ours.",
        "Republished partner content. Carried only under a licence, labelled with the original author and publisher, and linked to the original.",
      ),
      h("Coverage"),
      p("We aim to cover national, state and union territory health bodies, research institutions and independent health desks. Coverage is growing and is not yet complete for every state. A state page appears once we have something to show for it."),
      h("Advertising and sponsorship"),
      p("{{advertising_policy}}"),
      h("Contact"),
      p("Write to {{contact_email}}. To report an error, use the form on the corrections page."),
    ],
  },
  {
    slug: "editorial-policy",
    title: "Editorial policy",
    description: "How we source, review, label and correct our reporting.",
    body: [
      p("These are the standards we work to. The first group is enforced by our publishing system and cannot be skipped by anyone, including editors."),
      h("Rules the publishing system enforces"),
      ul(
        "Every item names its originating publisher and links directly to the specific notice, article or document.",
        "A report of ours is published only after a named editor approves the exact version that goes out. Any edit needs fresh approval.",
        "Clinical and high-impact reports also need sign-off from a credentialed medical reviewer, who must be a different person from the editor.",
        "Items about drug safety, outbreaks, vaccines, treatment or research results are never posted automatically.",
        "Analysis, press material and republished partner content are labelled as such.",
        "A correction keeps the address and the original publication time, and adds a dated note saying what changed.",
      ),
      h("Original reporting"),
      p("We publish a report under our own name only when we have added something: a checked comparison with an earlier notice, an on-record interview, local reporting or analysis of the underlying data. A new headline on someone else's work is not a report."),
      h("Sources and evidence"),
      ul(
        "We prefer primary sources: the notice, circular, dataset or paper itself.",
        "For research we say whether the work is peer reviewed, a preprint or a conference abstract, and note its limits where they matter.",
        "We attribute disputed figures to whoever published them and say when counts cannot be compared.",
        "If a source withdraws or changes a document we cited, we review every report that relied on it.",
      ),
      h("Medical review"),
      p("A medical reviewer checks clinical claims against the primary evidence before publication. Reviewers are named on the reports they review, with their specialty. Reviewers declare conflicts of interest, and those declarations appear on their profile pages."),
      h("Use of automation"),
      p("Software collects notices from approved publishers and may post a labelled source update automatically when the item is routine and the publisher's terms allow it. Software may help draft text privately. A person is responsible for every report published under a byline and verifies its claims and quotations."),
      h("Not medical advice"),
      p("We report news. Nothing here is advice about your own health. For a personal health decision, speak to a qualified clinician."),
      h("Corrections and complaints"),
      p("We correct material errors promptly and list them on the corrections page. If you are not satisfied with a response, see the complaints page."),
    ],
  },
  {
    slug: "contact",
    title: "Contact",
    description: "How to reach the newsroom.",
    body: [
      h("Newsroom"),
      p("Email: {{contact_email}}"),
      p("Phone: {{contact_phone}}"),
      p("Post: {{legal_name}}, {{registered_address}}"),
      h("Report an error"),
      p("Use the form on the corrections page. You will get a case number and we will reply if you leave a contact."),
      h("Publishers and rights holders"),
      p("To propose your site as a source, ask about how we link to you, or raise a rights objection, write to {{rights_contact}}."),
      h("Complaints"),
      p("For a formal complaint, see the complaints page."),
    ],
  },
  {
    slug: "complaints",
    title: "Complaints",
    description: "How to make a complaint and how it is handled.",
    body: [
      p("If you believe something we published is inaccurate, unfair, infringes your rights or intrudes on your privacy, you can complain. It costs nothing."),
      h("Step 1: tell the newsroom"),
      p("Use the form on the corrections page and choose the reason that fits. You will get a case number straight away. Urgent clinical safety and privacy reports go to the duty editor immediately."),
      h("Step 2: the grievance officer"),
      p("If you are not satisfied, write to our grievance officer, {{grievance_officer_name}}, at {{grievance_officer_contact}}. Quote your case number."),
      ul("We acknowledge a complaint within {{grievance_ack}}.", "We aim to resolve it within {{grievance_resolve}}."),
      h("What to include"),
      ul("The address of the page", "What you believe is wrong, and why", "Any evidence you can share", "How we can reach you"),
      h("What we do"),
      p("We record every complaint, the evidence, our decision and our reply. Where we find a material error we correct it and note the correction publicly. Where content must be removed, we remove it from the site and our feeds."),
      h("If you remain dissatisfied"),
      p("You may be able to take your complaint further under the rules that apply to digital news publishers in India. We will tell you the route that applies when we reply."),
    ],
  },
  {
    slug: "privacy",
    title: "Privacy",
    description: "What we collect, why, and how to make a privacy request.",
    body: [
      p("This notice explains what personal data {{legal_name}} handles when you use this site."),
      h("Reading the site"),
      ul(
        "You can read everything without an account.",
        "We do not ask for your location. You choose a state page yourself.",
        "We do not use advertising cookies or sell personal data.",
        "Like any website, our hosting provider's servers record technical details of each request, such as IP address, browser type and time, for security and reliability.",
      ),
      h("If you report an error or complain"),
      p("We keep what you tell us and any contact details you choose to give, so that we can investigate and reply. Contact details are seen only by the staff handling your case. They never appear on the site. We delete them {{case_retention}}."),
      h("Our staff"),
      p("We hold account details for staff, and publish the names, roles, relevant credentials and declared interests of reporters, editors and medical reviewers."),
      h("People named in the news"),
      p("We report on matters of public interest and avoid identifying patients. If you believe a report intrudes on your privacy, use the corrections form and choose the privacy reason, or write to the contact below."),
      h("Who processes data for us"),
      p("We use service providers for hosting and database storage. They process data on our instructions."),
      h("Links to other sites"),
      p("Source links take you to other publishers' sites. Their privacy practices are their own."),
      h("Your requests"),
      p("You can ask what personal data we hold about you, ask us to correct or delete it, or withdraw consent you have given. Write to {{privacy_contact}}. We will verify your identity before acting and reply within the period the law requires."),
      h("Changes"),
      p("We keep earlier versions of this notice. The version history below shows when each took effect."),
    ],
  },
  {
    slug: "terms",
    title: "Terms",
    description: "Terms of use for this site.",
    body: [
      p("These terms apply when you use this site, which is published by {{legal_name}}."),
      h("News, not medical advice"),
      p("We report news about health. Nothing on this site is medical advice, diagnosis or treatment. Do not delay seeing a qualified clinician because of something you read here."),
      h("Accuracy"),
      p("We work to be accurate and correct material errors when we find them. We cannot promise that every item is complete or current, particularly where it reflects another publisher's notice."),
      h("Other publishers' content"),
      p("Source updates link to pages published by others. Those publishers are responsible for their own content, and their terms apply on their sites. A link is not an endorsement."),
      h("Using our reports"),
      p("You may read, share and link to our reports. Please do not republish our reports in full, or present them as your own, without written permission. Content we carry under licence from a partner belongs to that partner."),
      h("Rights objections"),
      p("If you believe something here infringes your rights, write to {{rights_contact}} or use the corrections form. We act on valid objections promptly."),
      h("Liability"),
      p("To the extent the law allows, we are not liable for loss arising from reliance on this site. Nothing in these terms limits any right you have that cannot lawfully be limited."),
      h("Governing law"),
      p("These terms are governed by {{governing_law}}."),
    ],
  },
];

/** Seed any policy page that has no version yet. Never overwrites an existing page. */
export async function seedPolicyPages(db: Db, now: Date): Promise<number> {
  let created = 0;
  for (const page of PAGES) {
    if (await pageExists(db, page.slug)) continue;
    await savePage(db, null, { ...page, changeNote: "Initial draft prepared with the platform build. Not yet reviewed by the publisher's adviser." }, now);
    created++;
  }
  return created;
}
