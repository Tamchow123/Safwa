import { AccountMenu } from "@/components/auth/account-menu";
import { ThemeToggle } from "@/components/theme-toggle";

/** Compact top header: app name on mobile (the sidebar owns it on desktop). */
export function AppHeader() {
  return (
    <header className="bg-background/95 sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b px-4 backdrop-blur md:px-8">
      <span className="text-lg font-semibold tracking-tight md:hidden">
        Safwa
      </span>
      <div className="ml-auto flex items-center gap-1">
        <AccountMenu />
        <ThemeToggle />
      </div>
    </header>
  );
}
