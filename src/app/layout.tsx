import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getDb } from "@/db/client";
import { getBreaking, listSections, listTermsWithContent } from "@/core/reader";
import { Tabs } from "@/components/Tabs";
import { cached, TAG_FEED } from "@/lib/cache";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";
import "./globals.css";

// Every public page reads the published projection per request. Caching with
// explicit invalidation arrives with the distribution work (ARC-02).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description: SITE_TAGLINE,
  robots: { index: false, follow: true },
  alternates: { types: { "application/rss+xml": "/feed.xml" } },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a2540" };

const FOOTER_PUBLICATION: [string, string][] = [
  ["/about", "About"],
  ["/editorial-policy", "Editorial policy"],
  ["/corrections", "Corrections"],
  ["/contact", "Contact"],
];
const FOOTER_READERS: [string, string][] = [
  ["/submit-news", "Submit news"],
  ["/corrections#report", "Report an error"],
  ["/complaints", "Complaints"],
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
];

const SHORT: Record<string, string> = { policy: "Policy", "medicines-devices": "Medicines", "healthcare-delivery": "Healthcare", "public-health": "Public Health" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const db = getDb();
  const now = new Date();
  const { sections, states, breaking } = await cached(["layout-nav"], [TAG_FEED], async () => ({ sections: await listSections(db), states: await listTermsWithContent(db, "state", now), breaking: await getBreaking(db, now) }));
  const year = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", year: "numeric" }).format(now);
  const tabs = [{ href: "/", label: "Latest" }, ...sections.map((s) => ({ href: `/section/${s.slug}`, label: SHORT[s.slug] ?? s.name })), { href: "/states", label: "States" }];

  return (
    <html lang="en-IN">
      <body>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <header className="masthead">
          <div className="wrap masthead-bar">
            <details className="menu">
              <summary className="icon-button" aria-label="Menu">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
              </summary>
              <nav className="menu-panel" aria-label="All sections and states">
                <h2>Sections</h2>
                <ul>
                  <li>
                    <Link href="/latest">Latest updates</Link>
                  </li>
                  {sections.map((s) => (
                    <li key={s.slug}>
                      <Link href={`/section/${s.slug}`}>{s.name}</Link>
                    </li>
                  ))}
                </ul>
                <h2>States and union territories</h2>
                <ul>
                  {states.map((s) => (
                    <li key={s.slug}>
                      <Link href={`/state/${s.slug}`}>{s.name}</Link>
                    </li>
                  ))}
                  <li>
                    <Link href="/states">All states and union territories</Link>
                  </li>
                </ul>
                <h2>More</h2>
                <ul>
                  <li>
                    <Link href="/search">Search</Link>
                  </li>
                  <li>
                    <Link href="/submit-news">Submit news</Link>
                  </li>
                  <li>
                    <Link href="/about">About</Link>
                  </li>
                  <li>
                    <Link href="/corrections">Corrections</Link>
                  </li>
                </ul>
              </nav>
            </details>
            <Link className="masthead-title" href="/">
              {SITE_NAME}
            </Link>
            <div className="masthead-actions">
              <Link className="masthead-cta" href="/submit-news">
                Submit news
              </Link>
              <Link className="icon-button" href="/search" aria-label="Search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="6" />
                  <path d="M15 15l5.5 5.5" />
                </svg>
              </Link>
            </div>
          </div>
        </header>
        <Tabs items={tabs} />
        {breaking && (
          <div className="breaking" role="region" aria-label="Breaking news">
            <div className="wrap">
              <strong>Breaking</strong>
              <Link href={breaking.url}>{breaking.text}</Link>
            </div>
          </div>
        )}
        {process.env.DEMO_BANNER === "1" && (
          <div className="breaking" role="note">
            <div className="wrap">
              <strong>Demonstration</strong>This site shows sample content with fictional sources. It is not real news.
            </div>
          </div>
        )}
        <main id="content" className="wrap">
          {children}
        </main>
        <footer className="footer">
          <div className="wrap">
            <div className="footer-grid">
              <div className="footer-brand">
                <p className="footer-name">{SITE_NAME}</p>
                <p>{SITE_TAGLINE}</p>
                <p>
                  <Link className="footer-cta" href="/submit-news">
                    Submit news
                  </Link>
                </p>
              </div>
              <nav aria-labelledby="footer-sections">
                <h2 id="footer-sections">Sections</h2>
                <ul>
                  <li>
                    <Link href="/latest">Latest updates</Link>
                  </li>
                  {sections.map((s) => (
                    <li key={s.slug}>
                      <Link href={`/section/${s.slug}`}>{s.name}</Link>
                    </li>
                  ))}
                  <li>
                    <Link href="/states">States</Link>
                  </li>
                </ul>
              </nav>
              <nav aria-labelledby="footer-publication">
                <h2 id="footer-publication">Publication</h2>
                <ul>
                  {FOOTER_PUBLICATION.map(([href, label]) => (
                    <li key={href}>
                      <Link href={href}>{label}</Link>
                    </li>
                  ))}
                </ul>
              </nav>
              <nav aria-labelledby="footer-readers">
                <h2 id="footer-readers">For readers</h2>
                <ul>
                  {FOOTER_READERS.map(([href, label]) => (
                    <li key={href}>
                      <Link href={href}>{label}</Link>
                    </li>
                  ))}
                  <li>
                    <a href="/feed.xml">RSS feed</a>
                  </li>
                </ul>
              </nav>
            </div>
            <p className="footer-base">
              © {year} {SITE_NAME}. All times are Indian Standard Time. Source updates link to the original publisher.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
