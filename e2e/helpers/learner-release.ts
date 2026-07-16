/**
 * Node-only E2E fixture helper: loads the generated active pointer and
 * learner artifact programmatically and selects test entries by data
 * properties, so specs never depend on hand-typed or terminal-rendered
 * Arabic (CLAUDE.md rule).
 */
import { readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";

import {
  activePointerSchema,
  learnerReleaseSchema,
  type LearnerEntry,
  type LearnerRelease,
} from "../../modules/content/schema";
import {
  QUIZ_ELIGIBILITY_FIELDS,
  type QuizEligibilityField,
} from "../../modules/content/query";
import { normalizeForComparison } from "../../shared/arabic/normalize";

const PUBLIC_DIR = join(process.cwd(), "public");

let cached: LearnerRelease | null = null;

export function loadLearnerRelease(): LearnerRelease {
  if (cached) return cached;
  const pointer = activePointerSchema.parse(
    JSON.parse(
      readFileSync(join(PUBLIC_DIR, "content", "active.json"), "utf8"),
    ),
  );
  // Resolve the learner path safely inside public/.
  const learnerPath = normalize(join(PUBLIC_DIR, pointer.learner_url));
  if (!learnerPath.startsWith(PUBLIC_DIR + sep)) {
    throw new Error(`unsafe learner path: ${pointer.learner_url}`);
  }
  cached = learnerReleaseSchema.parse(
    JSON.parse(readFileSync(learnerPath, "utf8")),
  );
  return cached;
}

const SEARCHED_FORMS = [
  "madi",
  "mudari",
  "masdar",
  "ism_fail",
  "amr",
  "nahi",
] as const;

/** An entry whose full meaning is a substring of no other entry's meaning. */
export function uniqueMeaningEntry(): LearnerEntry {
  const entries = loadLearnerRelease().entries;
  const found = entries.find((entry) => {
    const needle = entry.meaning.toLowerCase();
    return (
      needle.length >= 6 &&
      entries.filter((other) => other.meaning.toLowerCase().includes(needle))
        .length === 1
    );
  });
  if (!found) throw new Error("no unique meaning found");
  return found;
}

/** An entry+form whose normalised value matches no other entry's forms. */
export function uniqueArabicForm(): {
  entry: LearnerEntry;
  field: (typeof SEARCHED_FORMS)[number];
  value: string;
} {
  const entries = loadLearnerRelease().entries;
  const allKeys = entries.flatMap((entry) =>
    SEARCHED_FORMS.map((field) => ({
      id: entry.id,
      key: normalizeForComparison(entry[field]),
    })),
  );
  for (const entry of entries) {
    for (const field of SEARCHED_FORMS) {
      const needle = normalizeForComparison(entry[field]);
      const matches = allKeys.filter(({ key }) => key.includes(needle));
      if (matches.length === 1) {
        return { entry, field, value: entry[field] };
      }
    }
  }
  throw new Error("no unique Arabic form found");
}

/** One protected duplicate-madi pair, derived from the data. */
export function duplicateMadiPair(): [LearnerEntry, LearnerEntry] {
  const entries = loadLearnerRelease().entries;
  const byMadi = new Map<string, LearnerEntry[]>();
  for (const entry of entries) {
    byMadi.set(entry.madi, [...(byMadi.get(entry.madi) ?? []), entry]);
  }
  const pair = [...byMadi.values()].find((group) => group.length === 2);
  if (!pair) throw new Error("no duplicate-madi pair found");
  return [pair[0], pair[1]];
}

/** An entry carrying a printed-source transcription note. */
export function transcriptionNoteEntry(): LearnerEntry {
  const found = loadLearnerRelease().entries.find(
    (entry) => entry.transcription_note,
  );
  if (!found) throw new Error("no transcription-note entry found");
  return found;
}

/** An entry with a displayed non-root field that is quiz-ineligible. */
export function ineligibleDisplayedFieldEntry(): {
  entry: LearnerEntry;
  field: QuizEligibilityField;
} {
  for (const entry of loadLearnerRelease().entries) {
    for (const field of QUIZ_ELIGIBILITY_FIELDS) {
      if (field === "root") continue;
      if (!entry.quiz_eligibility[field]) {
        return { entry, field };
      }
    }
  }
  throw new Error("no ineligible displayed field found");
}

/** Entry 369 (unresolved root). */
export function unresolvedRootEntry(): LearnerEntry {
  const found = loadLearnerRelease().entries.find((entry) => entry.id === 369);
  if (!found) throw new Error("entry 369 missing");
  return found;
}

/** The final entry in source order. */
export function lastEntry(): LearnerEntry {
  const entries = loadLearnerRelease().entries;
  return entries.reduce((last, entry) => (entry.id > last.id ? entry : last));
}

/** Expected first entry ids under the non-default sorts. */
export function expectedFirstIds(): {
  bookPage: number;
  meaning: number;
} {
  const entries = loadLearnerRelease().entries;
  const byPage = [...entries].sort(
    (a, b) => a.book_page - b.book_page || a.id - b.id,
  );
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  const byMeaning = [...entries].sort(
    (a, b) => collator.compare(a.meaning, b.meaning) || a.id - b.id,
  );
  return { bookPage: byPage[0].id, meaning: byMeaning[0].id };
}
