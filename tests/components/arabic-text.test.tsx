import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArabicText } from "@/components/arabic-text";
import { ARABIC_DEMO_TEXT } from "@/lib/arabic-demo";

describe("ArabicText", () => {
  it("applies lang, dir and the Arabic typography class", () => {
    render(<ArabicText data-testid="subject">{ARABIC_DEMO_TEXT}</ArabicText>);
    const el = screen.getByTestId("subject");
    expect(el).toHaveAttribute("lang", "ar");
    expect(el).toHaveAttribute("dir", "rtl");
    expect(el).toHaveClass("arabic-text");
  });

  it("preserves supplied class names alongside the base class", () => {
    render(
      <ArabicText data-testid="subject" className="text-2xl">
        {ARABIC_DEMO_TEXT}
      </ArabicText>,
    );
    const el = screen.getByTestId("subject");
    expect(el).toHaveClass("arabic-text");
    expect(el).toHaveClass("text-2xl");
  });

  it("renders text content without alteration", () => {
    render(<ArabicText data-testid="subject">{ARABIC_DEMO_TEXT}</ArabicText>);
    expect(screen.getByTestId("subject").textContent).toBe(ARABIC_DEMO_TEXT);
  });

  it("renders the requested semantic element", () => {
    render(
      <ArabicText as="p" data-testid="subject">
        {ARABIC_DEMO_TEXT}
      </ArabicText>,
    );
    expect(screen.getByTestId("subject").tagName).toBe("P");
  });
});
