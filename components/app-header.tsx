import { AccountMenu } from "@/components/auth/account-menu";
import { SyncStatusIndicator } from "@/components/sync/sync-status-indicator";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Compact top header: app name on mobile (the sidebar owns it on desktop).
 *
 * The horizontal padding carries a display-cutout inset on top of its normal
 * value, which is not decoration: Phase 18's `viewportFit: "cover"`
 * (app/layout.tsx) extends the viewport to the physical glass, so on a notched
 * device in landscape this bar's right-aligned controls — sync status, account
 * menu, theme toggle — would sit under the sensor housing. Padding the header
 * rather than its container keeps the background and bottom border full-bleed
 * and moves only the content, the same shape as the bottom nav's own inset.
 *
 * Only left and right. There is no `env(safe-area-inset-top)` here because
 * `appleWebApp.statusBarStyle` is `"default"`, which lays an installed iOS
 * window out BELOW the status bar rather than under it; a top inset would be
 * empty space on every device. The left inset stops at `md`, where the sidebar
 * takes over the left edge and absorbs it instead.
 */
export function AppHeader() {
  return (
    <header className="bg-background/95 sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b pr-[calc(1rem_+_env(safe-area-inset-right))] pl-[calc(1rem_+_env(safe-area-inset-left))] backdrop-blur md:pr-[calc(2rem_+_env(safe-area-inset-right))] md:pl-8">
      <span className="text-lg font-semibold tracking-tight md:hidden">
        Safwa
      </span>
      <div className="ml-auto flex items-center gap-1">
        <SyncStatusIndicator />
        <AccountMenu />
        <ThemeToggle />
      </div>
    </header>
  );
}
