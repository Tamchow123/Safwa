import { PageHeader } from "@/components/page-header";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { DataSettings } from "@/components/settings/data-settings";
import { StudyDefaultsSettings } from "@/components/settings/study-defaults-settings";
import { TimezoneSettings } from "@/components/settings/timezone-settings";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Study defaults, timezone, appearance preferences and data for this device."
      />
      <StudyDefaultsSettings />
      <TimezoneSettings />
      <AppearanceSettings />
      <DataSettings />
    </div>
  );
}
