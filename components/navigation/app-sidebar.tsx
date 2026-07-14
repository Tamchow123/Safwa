"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActiveRoute, NAV_ITEMS } from "@/components/navigation/nav-items";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** Desktop sidebar — hidden below the md breakpoint. */
export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside
      data-testid="app-sidebar"
      className="bg-sidebar sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r md:flex"
    >
      <div className="flex h-14 items-center px-5">
        <span className="text-lg font-semibold tracking-tight">Safwa</span>
      </div>
      <Separator />
      <nav aria-label="Primary" className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = isActiveRoute(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                  )}
                >
                  <item.icon aria-hidden className="size-5 shrink-0" />
                  {item.title}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
