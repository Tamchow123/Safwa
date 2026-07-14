import { PageHeader } from "@/components/page-header";
import { AppearanceSettings } from "@/components/settings/appearance-settings";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Appearance preferences for this device."
      />
      <AppearanceSettings />
    </div>
  );
}
