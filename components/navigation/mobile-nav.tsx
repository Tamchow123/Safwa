"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActiveRoute, NAV_ITEMS } from "@/components/navigation/nav-items";
import { cn } from "@/lib/utils";

/**
 * Mobile bottom-tab navigation — hidden at the md breakpoint and above.
 * Tab targets are at least 56px tall; safe-area padding keeps the bar clear
 * of device home indicators.
 */
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      data-testid="mobile-nav"
      className="bg-background fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5">
        {NAV_ITEMS.map((item) => {
          const active = isActiveRoute(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-xs",
                  active ? "text-primary font-medium" : "text-muted-foreground",
                )}
              >
                <item.icon aria-hidden className="size-5" />
                <span className="truncate">{item.title}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
