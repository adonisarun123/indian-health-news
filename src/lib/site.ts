/** Site identity. The publication name and domain are working values until the publisher confirms them. */
export const SITE_NAME = process.env.SITE_NAME ?? "India Health News";
// SITE_URL wins. On Vercel without it, the project's production domain is used, so canonical
// and share URLs are right from the first deploy. Set SITE_URL once a custom domain is attached.
const vercelDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;
export const SITE_URL = (process.env.SITE_URL ?? (vercelDomain ? `https://${vercelDomain}` : "http://localhost:3000")).replace(/\/+$/, "");
export const SITE_TAGLINE = "Indian health developments, who reported them and the original source in one tap.";

export function absolute(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
