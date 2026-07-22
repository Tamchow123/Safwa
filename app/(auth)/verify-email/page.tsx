import type { Metadata } from "next";
import { Suspense } from "react";
import { VerifyEmailStatus } from "@/components/auth/verify-email-status";

export const metadata: Metadata = {
  title: "Verify your email",
};

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailStatus />
    </Suspense>
  );
}
