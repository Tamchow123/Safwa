import { PageHeader } from "@/components/page-header";
import { WeakDrillSession } from "@/components/study/weak-drill-session";

/**
 * Validated `dimension`/`value` search params forwarded as raw strings — the
 * URL never carries a raw component key, attempt id or other internal
 * reference (§17); `WeakDrillSession` validates them against the current
 * weak-area groups before building any session.
 */
export default async function WeakDrillPage({
  searchParams,
}: {
  searchParams: Promise<{ dimension?: string; value?: string }>;
}) {
  const { dimension, value } = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Practice"
        description="A focused drill on exactly the components currently weak in this area."
      />
      <WeakDrillSession
        dimensionParam={dimension ?? null}
        valueParam={value ?? null}
      />
    </div>
  );
}
