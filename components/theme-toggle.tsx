"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppTheme } from "@/lib/preferences/use-app-theme";

/**
 * Icon-button theme switcher for the app header. The three options are
 * exposed as an accessible radio group so the selected theme is communicated
 * by state, not colour.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useAppTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <Sun
            aria-hidden
            className="size-5 scale-100 rotate-0 transition-transform dark:scale-0 dark:-rotate-90"
          />
          <Moon
            aria-hidden
            className="absolute size-5 scale-0 rotate-90 transition-transform dark:scale-100 dark:rotate-0"
          />
          <span className="sr-only">Theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme ?? "system"}
          onValueChange={setTheme}
        >
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden className="size-4" /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden className="size-4" /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden className="size-4" /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
