"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

const THEME_OPTIONS = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

function subscribeNoop(): () => void {
  return () => {};
}

/** True after hydration; SSR renders false so output stays hydration-safe. */
function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/**
 * Segmented theme control for the settings page. Selection is communicated
 * via aria-pressed and the button variant, not colour alone. The pressed
 * state is only rendered after mount because the stored theme is unknown
 * during SSR.
 */
export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex flex-wrap gap-2"
      data-testid="theme-selector"
    >
      {THEME_OPTIONS.map((option) => {
        const selected = mounted && (theme ?? "system") === option.value;
        return (
          <Button
            key={option.value}
            type="button"
            variant={selected ? "default" : "outline"}
            aria-pressed={selected}
            onClick={() => setTheme(option.value)}
            className="min-h-11 min-w-24"
          >
            <option.icon aria-hidden className="size-4" />
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
