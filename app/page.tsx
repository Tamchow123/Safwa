import { siteConfig } from "@/lib/site";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">
        {siteConfig.name}
      </h1>
      <p className="text-muted-foreground">{siteConfig.tagline}</p>
    </main>
  );
}
