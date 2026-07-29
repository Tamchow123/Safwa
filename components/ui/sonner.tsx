"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

/**
 * Where a toast sits, once the viewport reaches the physical screen edge.
 *
 * Phase 18 sets `viewportFit: "cover"` in `app/layout.tsx`, which is what
 * finally makes `env(safe-area-inset-bottom)` non-zero. That is the point of
 * it — but it also means sonner's own default of 16px from the bottom is now
 * measured from the edge of the glass rather than from the edge of the usable
 * area, so on a phone with a home indicator a toast would sit underneath it.
 *
 * The bottom offset therefore clears two things: the inset itself, and the
 * 56px mobile tab bar (`components/navigation/mobile-nav.tsx`), which is
 * fixed to the same edge and would otherwise cover the toast anyway. Auth
 * routes have no tab bar and get a slightly higher toast than they need,
 * which is the right way round — too high is a cosmetic imperfection, too low
 * is a message nobody reads.
 *
 * `env()` resolves to 0 wherever there is no inset, so the desktop offset
 * costs nothing on a machine that has none.
 */
const MOBILE_OFFSET = {
  bottom: "calc(env(safe-area-inset-bottom) + 4.5rem)",
  left: "1rem",
  right: "1rem",
} as const;
const DESKTOP_OFFSET = {
  bottom: "calc(env(safe-area-inset-bottom) + 1.5rem)",
  left: "1.5rem",
  right: "1.5rem",
} as const;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      offset={DESKTOP_OFFSET}
      mobileOffset={MOBILE_OFFSET}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
