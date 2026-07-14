import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/navigation/app-sidebar";
import { MobileNav } from "@/components/navigation/mobile-nav";
import { ArabicFontScaleInitializer } from "@/components/preferences/arabic-font-scale-initializer";

/**
 * Responsive application shell: skip link, desktop sidebar, top header,
 * main landmark and mobile bottom navigation. Extra bottom padding on
 * mobile keeps content clear of the fixed tab bar.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh w-full">
      <a
        href="#main"
        className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <ArabicFontScaleInitializer />
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 pb-24 outline-none md:px-8 md:py-8 md:pb-8"
        >
          {children}
        </main>
        <MobileNav />
      </div>
    </div>
  );
}
