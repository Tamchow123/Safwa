"use client";

import { useTheme } from "next-themes";
import { toast } from "sonner";

import { ArabicText } from "@/components/arabic-text";
import { ArabicFontSizeSelector } from "@/components/settings/arabic-font-size-selector";
import { ThemeSelector } from "@/components/settings/theme-selector";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ARABIC_DEMO_TEXT } from "@/lib/arabic-demo";
import { ARABIC_FONT_SCALE_LABELS } from "@/lib/preferences/arabic-font-scale";
import { useArabicFontScale } from "@/lib/preferences/use-arabic-font-scale";

export function AppearanceSettings() {
  const { setTheme } = useTheme();
  const { scale, setScale, reset: resetScale } = useArabicFontScale();

  function resetAppearance() {
    setTheme("system");
    resetScale();
    toast("Appearance settings reset", {
      description: "Theme is back to system and Arabic text size to default.",
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Theme</h2>
          </CardTitle>
          <CardDescription>
            Choose light, dark or follow your device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ThemeSelector />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Arabic text size</h2>
          </CardTitle>
          <CardDescription>
            Adjust how large Arabic text appears throughout the app.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ArabicFontSizeSelector value={scale} onChange={setScale} />
          <div className="bg-muted/50 rounded-lg border p-4">
            <p className="text-muted-foreground text-xs">
              Preview — {ARABIC_FONT_SCALE_LABELS[scale]}
            </p>
            <ArabicText
              as="p"
              className="mt-2 text-2xl"
              data-testid="arabic-preview"
            >
              {ARABIC_DEMO_TEXT}
            </ArabicText>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Reset appearance</h2>
          </CardTitle>
          <CardDescription>
            Restore the system theme and default Arabic text size.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={resetAppearance}
          >
            Reset appearance settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
