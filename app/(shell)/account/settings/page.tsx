import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountSettingsForm } from "@/components/account/account-settings-form";
import { PageHeader } from "@/components/page-header";
import { getServerSession } from "@/modules/auth/session";

// See app/(shell)/account/page.tsx's identical comment: this page also
// reads the per-request session and must never be statically prerendered.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account settings",
};

export default async function AccountSettingsPage() {
  const session = await getServerSession();
  if (!session?.user) {
    redirect("/login?next=/account/settings");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account settings"
        description="Saved to your Safwa account — separate from this device's local Settings page."
      />
      <AccountSettingsForm />
    </div>
  );
}
