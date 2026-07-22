import { describe, expect, it } from "vitest";
import { escapeHtml, renderEmail } from "@/modules/email/templates";

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'quote'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("renderEmail", () => {
  const URL_WITH_AMPERSAND =
    "https://safwa.example.com/verify-email?token=abc&next=/dashboard";

  it("renders verify-email with an escaped HTML link and a plain-text link", () => {
    const rendered = renderEmail("verify-email", { url: URL_WITH_AMPERSAND });
    expect(rendered.subject).toMatch(/verify/i);
    expect(rendered.html).toContain(escapeHtml(URL_WITH_AMPERSAND));
    expect(rendered.html).not.toContain("token=abc&next"); // raw & must be escaped
    expect(rendered.text).toContain(URL_WITH_AMPERSAND);
  });

  it("renders reset-password with an escaped HTML link and a plain-text link", () => {
    const rendered = renderEmail("reset-password", {
      url: URL_WITH_AMPERSAND,
    });
    expect(rendered.subject).toMatch(/reset/i);
    expect(rendered.html).toContain(escapeHtml(URL_WITH_AMPERSAND));
    expect(rendered.text).toContain(URL_WITH_AMPERSAND);
  });

  it("renders delete-account with an escaped HTML link and a plain-text link", () => {
    const rendered = renderEmail("delete-account", {
      url: URL_WITH_AMPERSAND,
    });
    expect(rendered.subject).toMatch(/delet/i);
    expect(rendered.html).toContain(escapeHtml(URL_WITH_AMPERSAND));
    expect(rendered.text).toContain(URL_WITH_AMPERSAND);
  });

  it("never includes the word 'password' as a value in any rendered body", () => {
    // Templates never receive password data at all — this documents that
    // invariant by construction rather than by inspecting a fixed string.
    for (const template of [
      "verify-email",
      "reset-password",
      "delete-account",
    ] as const) {
      const rendered = renderEmail(template, { url: URL_WITH_AMPERSAND });
      expect(rendered.html).not.toMatch(/password:\s*\S/i);
      expect(rendered.text).not.toMatch(/password:\s*\S/i);
    }
  });
});
