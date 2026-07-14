"use client";

import { Button } from "@/components/ui/button";
import {
  ARABIC_FONT_SCALE_LABELS,
  ARABIC_FONT_SCALES,
  type ArabicFontScale,
} from "@/lib/preferences/arabic-font-scale";

const SCALE_OPTIONS = Object.keys(ARABIC_FONT_SCALES) as ArabicFontScale[];

/**
 * Segmented Arabic text-size control. Selection is communicated via
 * aria-pressed and the button variant, not colour alone.
 */
export function ArabicFontSizeSelector({
  value,
  onChange,
}: {
  value: ArabicFontScale;
  onChange: (scale: ArabicFontScale) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Arabic text size"
      className="flex flex-wrap gap-2"
      data-testid="arabic-font-size-selector"
    >
      {SCALE_OPTIONS.map((option) => {
        const selected = value === option;
        return (
          <Button
            key={option}
            type="button"
            variant={selected ? "default" : "outline"}
            aria-pressed={selected}
            onClick={() => onChange(option)}
            className="min-h-11 min-w-24"
          >
            {ARABIC_FONT_SCALE_LABELS[option]}
          </Button>
        );
      })}
    </div>
  );
}
