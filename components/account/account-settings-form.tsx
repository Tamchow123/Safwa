"use client";

/**
 * Account settings form (Phase 15, phases-15.md §39) — theme, Arabic text
 * size, timezone and study defaults saved to the SERVER (`user_settings`
 * row), a separate surface from this device's local Dexie settings
 * (app/(shell)/settings). Loading, saving or resetting this form never
 * reads or writes Dexie — the two stores are deliberately never
 * auto-synced in this phase (Phase 16/17 reconciliation).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ArabicFontSizeSelector } from "@/components/settings/arabic-font-size-selector";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ArabicFontScale } from "@/lib/preferences/arabic-font-scale";
import type { AppTheme } from "@/lib/preferences/app-theme";
import type { AccountSettings } from "@/modules/auth/account-settings";
import { SESSION_DEFAULTS_BOUNDS } from "@/modules/profile/session-defaults";
import { availableTimezones } from "@/modules/profile/timezone";

const THEME_OPTIONS: { value: AppTheme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

async function parseSettingsResponse(
  response: Response,
): Promise<AccountSettings> {
  const body = (await response.json()) as { settings: AccountSettings };
  return body.settings;
}

export function AccountSettingsForm() {
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/account/settings");
        if (!response.ok) throw new Error("load failed");
        const loaded = await parseSettingsResponse(response);
        if (!cancelled) setSettings(loaded);
      } catch {
        if (!cancelled) {
          setLoadError("Couldn't load your account settings. Try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/account/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error("save failed");
      setSettings(await parseSettingsResponse(response));
      toast("Account settings saved");
    } catch {
      toast("Couldn't save your account settings", {
        description: "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (resetting) return;
    setResetting(true);
    try {
      const response = await fetch("/api/account/settings", {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("reset failed");
      setSettings(await parseSettingsResponse(response));
      toast("Account settings reset to defaults");
    } catch {
      toast("Couldn't reset your account settings", {
        description: "Please try again.",
      });
    } finally {
      setResetting(false);
    }
  }

  if (loadError !== null) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p role="alert" className="text-destructive text-sm">
            {loadError}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!settings) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">
            Loading account settings…
          </p>
        </CardContent>
      </Card>
    );
  }

  const zones = availableTimezones();

  return (
    <Card data-testid="account-settings-form">
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Account settings</h2>
        </CardTitle>
        <CardDescription>
          Saved to your account, separate from this device&apos;s local
          settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label>Theme</Label>
          <div role="group" aria-label="Theme" className="flex flex-wrap gap-2">
            {THEME_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={
                  settings.theme === option.value ? "default" : "outline"
                }
                aria-pressed={settings.theme === option.value}
                className="min-h-11 min-w-24"
                onClick={() =>
                  setSettings({ ...settings, theme: option.value })
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Arabic text size</Label>
          <ArabicFontSizeSelector
            value={settings.arabicFontScale}
            onChange={(scale: ArabicFontScale) =>
              setSettings({ ...settings, arabicFontScale: scale })
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="account-timezone">Timezone</Label>
          <select
            id="account-timezone"
            className="border-input w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            value={
              settings.timezone.mode === "iana"
                ? settings.timezone.timezone
                : "__browser__"
            }
            onChange={(event) => {
              const value = event.target.value;
              setSettings({
                ...settings,
                timezone:
                  value === "__browser__"
                    ? { mode: "browser" }
                    : { mode: "iana", timezone: value },
              });
            }}
          >
            <option value="__browser__">Use browser default</option>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label>Study defaults</Label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="account-question-count" className="text-xs">
                Questions per session
              </Label>
              <Input
                id="account-question-count"
                type="number"
                min={SESSION_DEFAULTS_BOUNDS.questionCount.min}
                max={SESSION_DEFAULTS_BOUNDS.questionCount.max}
                value={settings.sessionDefaults.questionCount}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    sessionDefaults: {
                      ...settings.sessionDefaults,
                      questionCount: Number(event.target.value),
                    },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="account-option-count" className="text-xs">
                Options per question
              </Label>
              <Input
                id="account-option-count"
                type="number"
                min={SESSION_DEFAULTS_BOUNDS.optionCount.min}
                max={SESSION_DEFAULTS_BOUNDS.optionCount.max}
                value={settings.sessionDefaults.optionCount}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    sessionDefaults: {
                      ...settings.sessionDefaults,
                      optionCount: Number(event.target.value),
                    },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="account-new-per-day" className="text-xs">
                New items per day
              </Label>
              <Input
                id="account-new-per-day"
                type="number"
                min={SESSION_DEFAULTS_BOUNDS.newPerDay.min}
                max={SESSION_DEFAULTS_BOUNDS.newPerDay.max}
                value={settings.sessionDefaults.newPerDay}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    sessionDefaults: {
                      ...settings.sessionDefaults,
                      newPerDay: Number(event.target.value),
                    },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="account-reviews-per-day" className="text-xs">
                Reviews per day
              </Label>
              <Input
                id="account-reviews-per-day"
                type="number"
                min={SESSION_DEFAULTS_BOUNDS.reviewsPerDay.min}
                max={SESSION_DEFAULTS_BOUNDS.reviewsPerDay.max}
                value={settings.sessionDefaults.reviewsPerDay}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    sessionDefaults: {
                      ...settings.sessionDefaults,
                      reviewsPerDay: Number(event.target.value),
                    },
                  })
                }
              />
            </div>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">
        <Button
          type="button"
          className="min-h-11"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save account settings"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={resetting}
          onClick={() => void handleReset()}
        >
          {resetting ? "Resetting…" : "Reset to defaults"}
        </Button>
      </CardFooter>
    </Card>
  );
}
