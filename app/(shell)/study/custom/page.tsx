import { PageHeader } from "@/components/page-header";
import { CustomSession } from "@/components/study/custom-session";

export default function CustomSessionPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Custom session"
        description="Compose a session from any combination of mode, forms, bāb, verb type, pages, progress state, timing and test mode."
      />
      <CustomSession />
    </div>
  );
}
