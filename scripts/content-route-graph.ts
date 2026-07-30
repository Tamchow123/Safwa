/**
 * Which app routes reach the modules that read content artifacts from disk?
 *
 * And, since round 3 of this slice's review, one thing broader than the title:
 * this file is also the sole enforcement point for "no undeclared filesystem
 * read in request-reachable code". That invariant is wider than
 * `outputFileTracingIncludes` and is what makes the route derivation below
 * trustworthy rather than merely plausible — see "TWO LISTS, NOT ONE".
 *
 * `next.config.ts`'s `outputFileTracingIncludes` has to name those routes
 * exactly. Nothing about that is self-checking: the paths those modules read
 * are built at runtime from a release id, so the tracer cannot infer them, and
 * a route added later that reaches the same modules would simply be missing
 * from the list. The failure that produces is not a build error — the deploy
 * succeeds and the route answers 503 to real traffic when a file it needs was
 * never bundled.
 *
 * So the list is derived here rather than maintained by hand, and
 * `tests/unit/next-config.test.ts` compares the derived set against the
 * committed config in BOTH directions — a missing entry and a stale one each
 * fail. This module is pure (`node:fs` and `node:path` only) so that test stays
 * hermetic and runs on every platform.
 *
 * TWO LISTS, NOT ONE. Deriving the routes only moves the hand-maintained list
 * down a level: the walk searches for a fixed set of LEAF modules, and a new
 * module that reads content files directly would make a route reaching only it
 * invisible — the same silent-503, one step removed. `findFilesystemReaders()`
 * closes that, and the test asserts its result is exactly
 * `CONTENT_FILESYSTEM_MODULES`. Both lists are checked; neither is trusted.
 *
 * That scan deliberately keys on the READ, not on the path. An earlier version
 * also required the file to mention a content path (`contentServerDir`,
 * `public/content`, …), which tied detection to today's exact spelling: factor
 * a shared `readJson(dir, name)` helper out of the two loaders and the new
 * caller matches no path pattern, so it is missed — a silent false NEGATIVE, in
 * a mechanism whose entire purpose is that a missed reader is invisible. So
 * ANY filesystem read outside the excluded trees must be either a declared
 * content leaf or on `NON_CONTENT_FILESYSTEM_READERS`, which is two entries
 * long and each carries its reason. A new reader of any kind therefore fails
 * the test by name, and the cost of a false positive is one line and a comment.
 *
 * WHAT THIS IS NOT: a TypeScript-accurate module resolver. It reads import
 * specifiers with a regex and resolves the forms this codebase uses for
 * internal modules — `@/...` and relative paths, static or dynamic. That is
 * enough because the modules it looks for are internal and reachable only
 * through those, and a bare specifier cannot resolve to one. Ordinary
 * re-exports and barrel files ARE followed, because the pattern matches
 * `from "..."` whatever keyword precedes it.
 *
 * Its blind spots, stated rather than implied, since "errs toward finding more"
 * is only true of the forms it models at all:
 *  - a computed or template-literal specifier (`import(`./x/${id}`)`) creates
 *    no edge, because there is no literal to resolve;
 *  - `require("...")` is not matched (this codebase is ESM throughout);
 *  - a route reached only through Next's file conventions rather than an
 *    import — layouts and templates, which the App Router bundles into the same
 *    function without the page importing them — is handled by walking the
 *    segment chain explicitly below, not by the import graph.
 * If any of those stops being hypothetical, this file needs to grow, and the
 * test that pins the leaf list is what will notice first.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The modules that actually read content artifacts from the filesystem.
 *
 * Internal by design: `findFilesystemReaders()` is the checked way to
 * ask this question, and a test asserts the two agree. A caller reaching for
 * this constant directly would be trusting the list this file exists to verify.
 */
const CONTENT_FILESYSTEM_MODULES = [
  "modules/content/server-manifests.ts",
  "modules/content/server-release-registry.ts",
] as const;

/**
 * Extensions that can participate in a chain. `.mts`/`.cts` are included
 * because `tsconfig.json` already admits them, so a module authored that way
 * must not silently break a chain that passes through it.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  "public",
  "content-server",
  "data",
  "e2e",
  "tests",
  "docs",
]);

/** Next.js file conventions that end up in a route's own server bundle. */
const SEGMENT_FILES = ["layout", "template", "default"];

// Static `from "x"` / `import "x"`, and dynamic `import("x")`. The dynamic
// form matters: a route that lazily imports a loader still needs its files.
// Deliberately keyword-agnostic before `from`, so `export * from "x"` and
// `export { y } from "x"` are followed like any other edge.
//
// What keeps this regex honest is not the regex: `tests/unit/next-config.test.ts`
// ("pins every route that reads content artifacts from disk") compares what
// this walk finds against the committed `outputFileTracingIncludes` in BOTH
// directions, so an edge this pattern fails to see shows up there as a config
// entry with no derived route, or the reverse. The gaps it cannot see at all
// are enumerated in the docblock above.
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/** Filesystem reads, for the leaf-list completeness check. */
const FS_READ_PATTERN =
  /\b(readFileSync|readFile|createReadStream|readdirSync|opendirSync)\s*\(/;

/**
 * Files that read from disk and are NOT content loaders, each with the reason.
 *
 * Kept explicit rather than pattern-matched: this is the list that makes
 * "any filesystem read must be accounted for" enforceable, and every entry is a
 * deliberate statement that a request can never reach that code.
 */
const NON_CONTENT_FILESYSTEM_READERS = [
  // Runs in `pnpm content:build`. Not reachable from a request — and it lives
  // in the same directory as the real loaders, which is why it needs naming
  // individually rather than a directory skip like `scripts/`, `db/`, `tools/`.
  "modules/content/build.ts",
] as const;

type ContentRoute = {
  /** Repo path of the route file, e.g. `app/api/health/route.ts`. */
  file: string;
  /** The route path Next knows it by, e.g. `/api/health`. */
  route: string;
  /** How it reaches the filesystem, nearest importer first. */
  via: string[];
};

/**
 * `app/api/health/route.ts` -> `/api/health`.
 *
 * Route groups `(name)` are removed because they do not appear in the served
 * path. Two other conventions share that bracket syntax and do NOT mean the
 * same thing — intercepting routes `(.)`/`(..)` and parallel slots `@slot` —
 * so this throws on them rather than silently emitting a key Next would not
 * recognise. A wrong key is worse than a loud failure: it would pin nothing,
 * and the config and the derivation would agree with each other while both
 * missed the route.
 */
function toRoutePath(file: string): string {
  const withoutApp = file
    .replace(/^app/, "")
    .replace(/\/(route|page)\.[cm]?tsx?$/, "");
  for (const segment of withoutApp.split("/")) {
    if (segment.startsWith("@")) {
      throw new Error(
        `content-route-graph: parallel route slot "${segment}" in ${file} is not supported. ` +
          "Teach toRoutePath what key Next uses for it before relying on outputFileTracingIncludes here.",
      );
    }
    if (/^\(\.+\)/.test(segment)) {
      throw new Error(
        `content-route-graph: intercepting route "${segment}" in ${file} is not supported. ` +
          "Teach toRoutePath what key Next uses for it before relying on outputFileTracingIncludes here.",
      );
    }
  }
  const withoutGroups = withoutApp.replace(/\/\([^/.@][^/]*\)/g, "");
  return withoutGroups === "" ? "/" : withoutGroups;
}

/**
 * The layout/template/default files Next bundles into a page's own function.
 * They are not imported by the page, so the import graph alone cannot see
 * them; the App Router composes them by directory position instead.
 */
function segmentChainFor(routeFile: string, known: ReadonlySet<string>): string[] {
  const chain: string[] = [];
  let dir = dirname(routeFile);
  while (dir !== "." && dir !== "" && dir !== "app") {
    for (const name of SEGMENT_FILES) {
      for (const ext of SOURCE_EXTENSIONS) {
        const candidate = `${dir}/${name}${ext}`;
        if (known.has(candidate)) chain.push(candidate);
      }
    }
    dir = dirname(dir);
  }
  for (const name of SEGMENT_FILES) {
    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = `app/${name}${ext}`;
      if (known.has(candidate)) chain.push(candidate);
    }
  }
  return chain;
}

export type FindOptions = {
  /** Repo root to scan. Defaults to this repository; set by fixture tests. */
  root?: string;
  /** Leaf modules to search for. Defaults to CONTENT_FILESYSTEM_MODULES. */
  leaves?: readonly string[];
};

function scanRoot(options: FindOptions): {
  root: string;
  files: string[];
  leaves: Set<string>;
} {
  const root = options.root ?? REPO_ROOT;
  return {
    root,
    files: listSourceFilesUnder(root).sort(),
    leaves: new Set(options.leaves ?? CONTENT_FILESYSTEM_MODULES),
  };
}

/** Every source file under a root, repo-relative and forward-slashed. */
function listSourceFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRECTORIES.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
      if (/\.test\.[cm]?tsx?$/.test(name)) continue;
      out.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return out;
}

function buildGraphUnder(
  root: string,
  files: readonly string[],
): Map<string, string[]> {
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const edges = new Set<string>();
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? "";
      let base: string;
      if (specifier.startsWith("@/")) base = specifier.slice(2);
      else if (specifier.startsWith(".")) {
        base = relative(root, resolve(dirname(join(root, file)), specifier))
          .split("\\")
          .join("/");
      } else continue;
      const candidates = [base];
      for (const ext of SOURCE_EXTENSIONS) {
        candidates.push(`${base}${ext}`, `${base}/index${ext}`);
      }
      for (const candidate of candidates) {
        if (known.has(candidate)) {
          edges.add(candidate);
          break;
        }
      }
    }
    graph.set(file, [...edges]);
  }
  return graph;
}

/**
 * Every route or page that transitively reaches a content filesystem module,
 * sorted by route path so the result is stable.
 */
export function findContentRoutes(options: FindOptions = {}): ContentRoute[] {
  const { root, files, leaves } = scanRoot(options);
  const graph = buildGraphUnder(root, files);
  const known = new Set(files);

  const found: ContentRoute[] = [];
  for (const file of files) {
    if (!/^app\/.*\/(route|page)\.[cm]?tsx?$/.test(file)) continue;

    // Start from the route file AND the layout/template chain around it: Next
    // puts all of them in the same server bundle, so any one of them reaching
    // a loader means this route needs the files pinned.
    const starts = [file, ...segmentChainFor(file, known)];
    const cameFrom = new Map<string, string>();
    const queue = [...starts];
    const seen = new Set(starts);
    let reached: string | null = null;
    while (queue.length > 0 && reached === null) {
      const current = queue.shift() as string;
      for (const next of graph.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        cameFrom.set(next, current);
        if (leaves.has(next)) {
          reached = next;
          break;
        }
        queue.push(next);
      }
    }
    if (reached === null) continue;

    const chain: string[] = [];
    for (
      let node: string | undefined = reached;
      node !== undefined;
      node = cameFrom.get(node)
    ) {
      if (!starts.includes(node)) chain.unshift(node);
    }
    found.push({ file, route: toRoutePath(file), via: chain });
  }
  return found.sort((a, b) =>
    a.route < b.route ? -1 : a.route > b.route ? 1 : 0,
  );
}

/**
 * Every request-reachable module that reads from the filesystem at all, found
 * by scanning rather than by trusting a list.
 *
 * This is what stops the route derivation from resting on an assumption. It
 * keys on the READ, not on the path: any module that starts reading files —
 * whatever it names its directory variable, whatever case it uses — shows up
 * here, the test comparing this against the leaf list fails, and whoever added
 * it is told to declare it, instead of a route quietly shipping unpinned and
 * 503ing later. Matching on path spellings instead would miss exactly the case
 * this is for (see the docblock at the top of the file).
 *
 * Excluded, and nothing else: the graph walk's own directory skips, the
 * `scripts/`, `db/` and `tools/` CLI trees (never a request path), and
 * `NON_CONTENT_FILESYSTEM_READERS` — one entry, for the build-time reader that
 * happens to live among the loaders.
 */
export function findFilesystemReaders(): string[] {
  const excused = new Set<string>(NON_CONTENT_FILESYSTEM_READERS);
  const readers: string[] = [];
  for (const file of listSourceFilesUnder(REPO_ROOT).sort()) {
    if (excused.has(file)) continue;
    if (file.startsWith("scripts/")) continue; // tooling, not request paths
    if (file.startsWith("tools/")) continue; // ditto — docs-verify and friends
    if (file.startsWith("db/")) continue; // migration/registration entry points
    const source = stripComments(readFileSync(join(REPO_ROOT, file), "utf8"));
    if (FS_READ_PATTERN.test(source)) readers.push(file);
  }
  return readers;
}

/**
 * Enough comment removal that PROSE about reading files is not mistaken for
 * code that reads them — `next.config.ts`'s own docblock explains the tracer's
 * blind spot in exactly those words, and matched before this existed.
 *
 * Block comments go entirely; line comments go only when the `//` starts the
 * line, which leaves `"https://…"` inside a string alone. A trailing comment
 * after code survives, so the residual error is a false POSITIVE — a loud test
 * failure naming a file, not a silent gap. That is the direction to be wrong in
 * here: the whole point of this scan is that a missed reader is invisible.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The leaf modules the route walk searches for, for the test that pins them. */
export function declaredContentFilesystemModules(): string[] {
  return [...CONTENT_FILESYSTEM_MODULES].sort();
}
