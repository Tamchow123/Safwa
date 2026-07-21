/**
 * Chrome-less layout for auth pages (Phase 15, phases-15.md §34/§35).
 * Deliberately outside `app/(shell)/`'s `<AppShell>` — auth pages are a
 * standalone flow, not part of the main study navigation.
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
