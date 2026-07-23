import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ChangePasswordDialog } from "@/components/account/change-password-dialog";
import { DeleteAccountDialog } from "@/components/account/delete-account-dialog";
import { SignOutButton } from "@/components/account/sign-out-button";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getServerSession } from "@/modules/auth/session";

// This page reads the per-request session and redirects unauthenticated
// visitors — it must never be statically prerendered. Without this,
// `next build` attempts a static pass that calls getAuth() (via
// getServerSession()) before Next can detect the headers()-based dynamic
// API usage inside it, so a dev-only env (http://, console-file
// transport) fails the production-invariant check at BUILD time rather
// than correctly deferring to request time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account",
};

const MEMBER_SINCE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

export default async function AccountPage() {
  const session = await getServerSession();
  if (!session?.user) {
    redirect("/login?next=/account");
  }

  const { user } = session;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account"
        description="Your Safwa account details and security."
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{user.name}</h2>
          </CardTitle>
          <CardDescription>{user.email}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {user.emailVerified ? (
              <Badge variant="secondary">Email verified</Badge>
            ) : (
              <Badge variant="outline">Email not verified</Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            Member since {MEMBER_SINCE_FORMAT.format(new Date(user.createdAt))}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Your progress</h2>
          </CardTitle>
          <CardDescription>
            Your study progress syncs to your account while you’re online, so
            it’s backed up beyond this device. You can keep studying offline —
            changes sync when you reconnect. Manage local settings and export
            your data from Settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/settings">Go to device settings</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Account settings</h2>
          </CardTitle>
          <CardDescription>
            Theme, Arabic text size, timezone and study defaults saved to your
            account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/account/settings">Manage account settings</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Security</h2>
          </CardTitle>
          <CardDescription>
            Change your password or sign out of this device.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <ChangePasswordDialog />
          <SignOutButton />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Danger zone</h2>
          </CardTitle>
          <CardDescription>
            Permanently delete your account and every server-stored record tied
            to it. This device&apos;s local study progress is never deleted by
            this action.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteAccountDialog email={user.email} />
        </CardContent>
      </Card>
    </div>
  );
}
