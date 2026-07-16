import { cn } from "@/lib/utils";

type ArabicTextElement =
  "span" | "p" | "div" | "h1" | "h2" | "h3" | "blockquote";

type ArabicTextProps = {
  /** Semantic element to render. Defaults to an inline span. */
  as?: ArabicTextElement;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "dir" | "lang">;

/**
 * Renders Arabic content with the correct language, direction, font and the
 * user's Arabic text-size preference. `unicode-bidi: isolate` (via the
 * `.arabic-text` class) keeps RTL content from reordering surrounding
 * English UI. The app chrome stays LTR — RTL is applied per element only.
 *
 * The children are wrapped in an inner scaling span so the user's size
 * multiplier composes with any font-size utility on the outer element
 * (e.g. `text-2xl`) instead of being overridden by it.
 */
export function ArabicText({
  as: Component = "span",
  className,
  children,
  ...props
}: ArabicTextProps) {
  return (
    <Component
      lang="ar"
      dir="rtl"
      className={cn("arabic-text", className)}
      {...props}
    >
      <span className="arabic-text-scale">{children}</span>
    </Component>
  );
}
