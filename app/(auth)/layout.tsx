import Link from "next/link";

/**
 * Chrome-less layout for auth pages (Phase 15, phases-15.md §34/§35).
 * Deliberately outside `app/(shell)/`'s `<AppShell>` — auth pages are a
 * standalone flow, not part of the main study navigation. Still needs a way
 * back to guest study without relying on the browser's own back button
 * (there is no shell nav here to fall back on).
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="p-4">
        <Link
          href="/"
          className="focus-visible:ring-ring rounded-sm text-lg font-semibold tracking-tight outline-none focus-visible:ring-2"
        >
          Safwa
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center p-6 pt-0">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
