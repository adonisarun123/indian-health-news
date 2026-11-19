/** Site identity. The publication name and domain are working values until the publisher confirms them. */
export const SITE_NAME = process.env.SITE_NAME ?? "India Health News";
export const SITE_URL = (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
export const SITE_TAGLINE = "Indian health developments, who reported them and the original source in one tap.";

export function absolute(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
