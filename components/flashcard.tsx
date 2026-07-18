"use client";

import { cn } from "@/lib/utils";

export type FlashcardProps = {
  /** The prompt face content (already wrapped in ArabicText where Arabic). */
  front: React.ReactNode;
  /** The answer face content (revealed after flipping). */
  back: React.ReactNode;
  /** Small caption above each face, e.g. "Arabic form" / "Meaning". */
  frontCaption: string;
  backCaption: string;
  /** Whether the answer face is showing. */
  flipped: boolean;
  /** Toggle the face (click/tap/Space/Enter). */
  onFlip: () => void;
  /**
   * When true, no 3D flip transform is used: the visible face is swapped
   * directly. Global CSS also neutralises transitions, but the reduced-motion
   * variant is structurally different (single face, no transform) so there is
   * nothing that could animate at all.
   */
  reducedMotion: boolean;
};

function Face({
  caption,
  children,
  hidden = false,
  className,
}: {
  caption: string;
  children: React.ReactNode;
  /** Excluded from the accessibility tree when its face is not showing. */
  hidden?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden={hidden || undefined}
      className={cn(
        "flex min-h-52 flex-col items-center justify-center gap-3 p-6 text-center",
        className,
      )}
    >
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {caption}
      </span>
      <div className="flex min-w-0 items-center justify-center break-words">
        {children}
      </div>
    </div>
  );
}

/**
 * A flippable flashcard. The whole card is a single button so keyboard users
 * flip with Space/Enter and pointer users tap anywhere; rating controls live
 * OUTSIDE this button (never nested interactive elements). The button's
 * accessible name is its VISIBLE face content plus a spoken instruction — the
 * answer is kept out of the accessibility tree until the card is flipped (the
 * answer face is absent under reduced motion, and `aria-hidden` in the animated
 * variant where both faces coexist in the DOM).
 */
export function Flashcard({
  front,
  back,
  frontCaption,
  backCaption,
  flipped,
  onFlip,
  reducedMotion,
}: FlashcardProps) {
  const instruction = flipped ? "Show the prompt again" : "Reveal the answer";

  return (
    <button
      type="button"
      onClick={onFlip}
      data-testid="flashcard"
      data-flipped={flipped}
      data-reduced-motion={reducedMotion}
      aria-pressed={flipped}
      className="border-border bg-card text-card-foreground focus-visible:ring-ring/50 focus-visible:border-ring block w-full rounded-xl border shadow-sm outline-none focus-visible:ring-3"
    >
      {reducedMotion ? (
        <Face caption={flipped ? backCaption : frontCaption}>
          {flipped ? back : front}
        </Face>
      ) : (
        <div className="relative [perspective:1200px]">
          <div
            className="relative transition-transform duration-500 [transform-style:preserve-3d]"
            style={{ transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
          >
            <Face
              caption={frontCaption}
              hidden={flipped}
              className="[backface-visibility:hidden]"
            >
              {front}
            </Face>
            <Face
              caption={backCaption}
              hidden={!flipped}
              className="absolute inset-0 [transform:rotateY(180deg)] [backface-visibility:hidden]"
            >
              {back}
            </Face>
          </div>
        </div>
      )}
      <span className="sr-only">{instruction}</span>
    </button>
  );
}
