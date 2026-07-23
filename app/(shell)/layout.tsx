import { AppShell } from "@/components/app-shell";
import { SyncProvider } from "@/components/sync/sync-provider";

export default function ShellLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <SyncProvider>
      <AppShell>{children}</AppShell>
    </SyncProvider>
  );
}
