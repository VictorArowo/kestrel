"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

const ITEMS = [
  { key: "1", href: "/", label: "new", match: (p: string) => p === "/" },
  { key: "2", href: "/strategies", label: "strategies", match: (p: string) => p.startsWith("/strategies") },
  { key: "3", href: "/portfolios", label: "portfolios", match: (p: string) => p.startsWith("/portfolios") },
  { key: "4", href: "/chats", label: "chats", match: (p: string) => p.startsWith("/chat") },
];

/** The function-key strip. Number keys jump between sections when you're not typing. */
export function Nav() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const item = ITEMS.find((i) => i.key === e.key);
      if (item) router.push(item.href);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <header className="border-b border-line bg-canvas sticky top-0 z-20">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6 h-11 flex items-center gap-4 sm:gap-6">
        <Link href="/" className="text-amber font-semibold tracking-tight" style={{ fontStretch: "112.5%" }}>
          kestrel
        </Link>
        <nav className="flex items-center gap-3 sm:gap-4 overflow-x-auto [scrollbar-width:none]" aria-label="Sections">
          {ITEMS.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-1.5 whitespace-nowrap ${active ? "text-amber sm:text-ink" : "text-dim hover:text-ink"}`}
              >
                <span className={`kbd hidden sm:inline-block ${active ? "!text-amber !border-amber" : ""}`}>{item.key}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <span className="ml-auto hidden sm:block text-2xs text-faint">paper trading only</span>
      </div>
    </header>
  );
}
