import { PageHeader } from "@/components/page-header";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { DataSettings } from "@/components/settings/data-settings";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Appearance preferences and data for this device."
      />
      <AppearanceSettings />
      <DataSettings />
    </div>
  );
}
