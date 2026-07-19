"use client";

/**
 * Study session defaults (PRODUCT_REQUIREMENTS.md §4.4, Phase 11): questions
 * per session, MC options per question, new items/day and reviews/day —
 * documented defaults 20 · 4 · 10 · 20, editable and stored durably like every
 * other device setting. Out-of-range input is clamped on save (the stored row
 * is always valid; the generator would reject an invalid option count).
 */
import { useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import {
  DEFAULT_SESSION_DEFAULTS,
  SESSION_DEFAULTS_BOUNDS,
  type SessionDefaults,
} from "@/modules/profile/session-defaults";

const FIELDS: {
  key: keyof SessionDefaults;
  label: string;
  description: string;
}[] = [
  {
    key: "questionCount",
    label: "Questions per session",
    description: "How many questions a study session contains.",
  },
  {
    key: "optionCount",
    label: "Options per question",
    description:
      "Answer choices shown in multiple-choice questions. Question types with small answer pools (like the six bābs) show fewer.",
  },
  {
    key: "newPerDay",
    label: "New items per day",
    description: "New words introduced by mixed sessions each day.",
  },
  {
    key: "reviewsPerDay",
    label: "Reviews per day",
    description: "Review target used by mixed sessions each day.",
  },
];

export function StudyDefaultsSettings() {
  const { defaults, loaded, update } = useSessionDefaults();
  const [draft, setDraft] = useState<
    Partial<Record<keyof SessionDefaults, string>>
  >({});
  const [saving, setSaving] = useState(false);
  const idPrefix = useId();

  const valueOf = (key: keyof SessionDefaults): string =>
    draft[key] ?? String(defaults[key]);

  const clamp = (key: keyof SessionDefaults, raw: string): number => {
    const bounds = SESSION_DEFAULTS_BOUNDS[key];
    const parsed = Number.parseInt(raw, 10);
    // An emptied/unparseable field falls back to the CURRENTLY STORED value —
    // never the documented default, which would silently discard a prior
    // choice the learner wasn't editing.
    if (Number.isNaN(parsed)) return defaults[key];
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
  };

  const save = async () => {
    setSaving(true);
    try {
      const next: SessionDefaults = {
        questionCount: clamp("questionCount", valueOf("questionCount")),
        optionCount: clamp("optionCount", valueOf("optionCount")),
        newPerDay: clamp("newPerDay", valueOf("newPerDay")),
        reviewsPerDay: clamp("reviewsPerDay", valueOf("reviewsPerDay")),
      };
      await update(next);
      setDraft({});
      toast("Study defaults saved", {
        description: `${next.questionCount} questions · ${next.optionCount} options · ${next.newPerDay} new/day · ${next.reviewsPerDay} reviews/day.`,
      });
    } catch {
      toast("Couldn't save study defaults", {
        description: "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      await update(DEFAULT_SESSION_DEFAULTS);
      setDraft({});
      toast("Study defaults reset", {
        description: "Back to 20 questions · 4 options · 10 new · 20 reviews.",
      });
    } catch {
      toast("Couldn't reset study defaults", {
        description: "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Study defaults</h2>
        </CardTitle>
        <CardDescription>
          Session length, answer options and daily targets used by study modes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => {
            const bounds = SESSION_DEFAULTS_BOUNDS[field.key];
            const inputId = `${idPrefix}-${field.key}`;
            return (
              <div key={field.key} className="space-y-1">
                <label htmlFor={inputId} className="text-sm font-medium">
                  {field.label}
                </label>
                <Input
                  id={inputId}
                  type="number"
                  inputMode="numeric"
                  min={bounds.min}
                  max={bounds.max}
                  step={1}
                  className="min-h-11"
                  disabled={!loaded || saving}
                  value={valueOf(field.key)}
                  data-testid={`study-default-${field.key}`}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                />
                <p className="text-muted-foreground text-xs">
                  {field.description} ({bounds.min}–{bounds.max})
                </p>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className="min-h-11"
            disabled={!loaded || saving}
            onClick={save}
            data-testid="study-defaults-save"
          >
            Save study defaults
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!loaded || saving}
            onClick={reset}
            data-testid="study-defaults-reset"
          >
            Reset to 20 · 4 · 10 · 20
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
