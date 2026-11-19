import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { simplePageGraph } from "@/core/jsonld";
import { SUBMISSION_KINDS } from "@/core/submissions";
import { first, pageMeta } from "@/lib/page";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { submitNewsAction } from "./actions";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export function generateMetadata(): Promise<Metadata> {
  return pageMeta({ title: "Submit news", description: `Send a press release, announcement, research finding or story tip to the ${SITE_NAME} desk. Every submission is reviewed by an editor.`, path: "/submit-news", indexable: true });
}

/** Public request form: organisations and readers ask the desk to consider their news. Nothing is published from here. */
export default async function SubmitNews({ searchParams }: Props) {
  const sp = await searchParams;
  const reference = (first(sp.ref) ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
  const error = first(sp.error)?.slice(0, 300);
  return (
    <div className="submit">
      <JsonLd graph={simplePageGraph({ origin: SITE_URL, name: SITE_NAME }, { type: "ContactPage", name: "Submit news", path: "/submit-news" })} />
      <div className="prose">
        <h1 className="page-title">Submit news</h1>
        <p className="intro">Hospitals, public bodies, researchers, companies, health organisations and readers can send news to our desk. An editor reads every submission.</p>
      </div>

      <div className="submit-grid">
        <section id="form" aria-labelledby="form-heading">
          <h2 id="form-heading" className="visually-hidden">
            Your submission
          </h2>
          {reference ? (
            <div className="note" role="status">
              <p>
                <strong>Thank you. Your submission has reached the desk.</strong>
              </p>
              {reference !== "received" && (
                <p>
                  Your reference is <strong>{reference}</strong>. Quote it if you write to us about this submission.
                </p>
              )}
              <p>An editor will review it. We reply only if we need more information or decide to report it.</p>
              <p>
                <Link href="/submit-news#form">Send another</Link>
              </p>
            </div>
          ) : (
            <>
              {error && (
                <p className="flash error" role="alert">
                  {error}
                </p>
              )}
              <form action={submitNewsAction} className="form">
                <div>
                  <label htmlFor="kind">What are you sending?</label>
                  <select id="kind" name="kind" defaultValue="press_release" required>
                    {Object.entries(SUBMISSION_KINDS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="headline">Headline</label>
                  <input id="headline" name="headline" type="text" minLength={10} maxLength={200} required />
                </div>
                <div>
                  <label htmlFor="details">
                    Details <span className="hint">What happened, where, when and who is involved. Paste the full release if you have one.</span>
                  </label>
                  <textarea id="details" name="details" minLength={50} maxLength={5000} required />
                </div>
                <div>
                  <label htmlFor="link">
                    Link to the original document or page <span className="hint">Optional, but it speeds up verification.</span>
                  </label>
                  <input id="link" name="link" type="url" placeholder="https://" maxLength={2048} />
                </div>
                <div className="form-row">
                  <div>
                    <label htmlFor="name">Your name</label>
                    <input id="name" name="name" type="text" minLength={2} maxLength={120} autoComplete="name" required />
                  </div>
                  <div>
                    <label htmlFor="organisation">
                      Organisation <span className="hint">Optional.</span>
                    </label>
                    <input id="organisation" name="organisation" type="text" maxLength={160} autoComplete="organization" />
                  </div>
                </div>
                <div className="form-row">
                  <div>
                    <label htmlFor="email">Email</label>
                    <input id="email" name="email" type="email" maxLength={160} autoComplete="email" required />
                  </div>
                  <div>
                    <label htmlFor="phone">
                      Phone <span className="hint">Optional.</span>
                    </label>
                    <input id="phone" name="phone" type="tel" maxLength={30} autoComplete="tel" />
                  </div>
                </div>
                <p className="meta">Your contact details are seen only by the editors handling your submission. They are never published.</p>
                <div className="checks">
                  <label>
                    <input type="checkbox" name="confirmed" value="yes" required />
                    <span>The information is accurate to the best of my knowledge and I am allowed to share it.</span>
                  </label>
                </div>
                {/* Honeypot: hidden from people, filled by bots. */}
                <div className="visually-hidden" aria-hidden="true">
                  <label htmlFor="website">Leave this field empty</label>
                  <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
                </div>
                <div>
                  <button className="button primary" type="submit">
                    Send to the desk
                  </button>
                </div>
              </form>
            </>
          )}
        </section>

        <aside className="panel submit-aside" aria-labelledby="how-heading">
          <h2 id="how-heading">What happens next</h2>
          <ol>
            <li>Your submission goes to a private queue that only our editors can open.</li>
            <li>An editor checks it against the original source and decides whether it is news for our readers.</li>
            <li>If we report it, we write it in our own words, name the source and link to it.</li>
          </ol>
          <h2>Before you send</h2>
          <ul>
            <li>Sending news does not guarantee that it is published, and we cannot promise a date.</li>
            <li>We do not accept payment for coverage.</li>
            <li>Claims about treatments, medicines or devices need evidence and may go to a medical reviewer.</li>
            <li>Do not include patient names, records or other personal health information.</li>
          </ul>
          <p className="meta">
            Found a mistake in something we published? <Link href="/corrections#report">Report an error</Link> instead.
          </p>
        </aside>
      </div>
    </div>
  );
}
