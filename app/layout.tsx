import type { Metadata, Viewport } from "next";
import { Geist, Noto_Naskh_Arabic } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { siteConfig } from "@/lib/site";
import { cn } from "@/lib/utils";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

const notoNaskhArabic = Noto_Naskh_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "700"],
  variable: "--font-arabic",
});

export const metadata: Metadata = {
  title: siteConfig.title,
  description: siteConfig.description,
  applicationName: siteConfig.name,
  // Declared here rather than left to file conventions, so every icon this
  // app ships comes from the one generated set under `public/icons/`
  // (scripts/generate-icons.ts) and nothing is silently picked up from a
  // stray `app/favicon.ico`.
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    // iOS has no manifest support worth relying on: this is what makes an
    // added-to-home-screen Safwa open without browser chrome.
    capable: true,
    title: siteConfig.shortName,
    statusBarStyle: "default",
  },
};

/**
 * Viewport and installed-window chrome (Phase 18).
 *
 * `viewportFit: "cover"` is the point of this export. `components/navigation/
 * mobile-nav.tsx` has carried `pb-[env(safe-area-inset-bottom)]` since the
 * shell was built, but that variable resolves to 0 unless the document opts
 * into the display cutout — so on a phone with a home indicator the bottom tab
 * bar sat underneath it. Nothing looked broken in a browser, because browser
 * chrome absorbed the gap; installed, with no chrome to hide behind, it would
 * have been a row of tabs a thumb could not reliably hit.
 *
 * `themeColor` matches the manifest's, and is repeated here because the two
 * are consumed by different things: the manifest's tints an installed window,
 * this one tints the browser UI of a normal tab.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: siteConfig.themeColor,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "h-full font-sans antialiased",
        geist.variable,
        notoNaskhArabic.variable,
      )}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
