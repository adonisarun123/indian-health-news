"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Tabs({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  const current = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="tabs" aria-label="Sections">
      {/* The bar scrolls sideways on narrow screens rather than wrapping. */}
      <ul>
        {items.map((i) => (
          <li key={i.href}>
            <Link href={i.href} aria-current={current(i.href) ? "page" : undefined}>
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
