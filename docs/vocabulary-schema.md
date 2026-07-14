# Safwa Vocabulary Schema (v2.2.0)

This document describes every field in `data/safwa-vocabulary.v2.json` and its
companion files, the provenance/status system, and the **field-level**
quiz-eligibility rules. Two principles govern everything:

1. **The presence of an entry or value never means it is quiz-eligible.**
   Eligibility is always an explicit boolean, per field.
2. **A transcription note does not invalidate the whole entry.** It disables
   exactly the field(s) it concerns (see the mapping below); every other field
   of that entry stays usable.

Files:

| File                                | Purpose                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `data/safwa-mujarrad.original.json` | Byte-identical copy of the source transcription. Read-only, never regenerated.                   |
| `data/safwa-vocabulary.v2.json`     | Combined enriched dataset (entries + patterns + candidates + statistics).                        |
| `data/mazid-fih-patterns.json`      | Forms II–X templates only (`dataset_status: pattern_templates`, `lexical_claims: false`).        |
| `data/mazid-fih-candidates.json`    | **Incomplete seed dataset** of lexical mazid fih verbs. Not production-ready, not quiz-eligible. |
| `data/.review-rows.json`            | Machine-readable manual-review queue.                                                            |
| `docs/manual-review-required.md`    | The exact Markdown render of those rows (validator-enforced byte equality with the builder).     |

Regeneration: `python scripts/enrich-vocabulary.py`, then
`python scripts/validate-vocabulary.py` (non-zero exit on any failure; the
validator imports the enrichment module so shared configuration cannot drift).

## Status enums

| Status                              | Meaning                                                                                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_transcribed`                | Transcribed from the printed book. All original fields are this implicitly.                                                                                                                                                                               |
| `internally_validated`              | Reconstructed value cross-checked **only against other printed forms of the same book**. NOT independent verification.                                                                                                                                    |
| `algorithmically_derived`           | Produced by a documented rule; no confirmation of any kind.                                                                                                                                                                                               |
| `needs_review`                      | Conflicting or insufficient evidence; a human must decide. Always has review-report coverage.                                                                                                                                                             |
| `blocked_by_transitivity_review`    | Generated form intentionally **not produced** because the entry's transitivity is `needs_review`. Cell has `blocked_by: "transitivity"`, `value: null`, `quiz_eligible: false`. Resolving the transitivity review unblocks it on the next enrichment run. |
| `verified` / independently verified | Checked against an external authoritative source. Requires `provenance.source` + `reviewed_by`. Currently used by **zero** records.                                                                                                                       |
| `not_applicable`                    | The form does not exist for this entry (e.g. passive of an intransitive verb).                                                                                                                                                                            |
| `curated`                           | (provenance type) Set by a human-maintained override table in the script.                                                                                                                                                                                 |

## Mujarrad entry — source fields (immutable)

`id` (1–455, never renumbered), `madi`, `mudari`, `masdar`, `meaning`,
`ism_fail`, `amr`, `nahi`, `bab`, `bab_arabic`, `verb_type`,
`verb_type_arabic`, `book_page`, `transcription_note` (14 entries).

## Mujarrad entry — derived fields

| Field                                                | Notes                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`, `root_compact`, `root_letters`               | Three radicals; bare `ء`; true `و`/`ي`; representations always agree.                                                                                                                                                                       |
| `form_number` = 1, `form_type` = `thulathi_mujarrad` |                                                                                                                                                                                                                                             |
| `root_provenance`                                    | `{type, method, source, reviewed_by}`; `type` equals `data_quality.root_status`.                                                                                                                                                            |
| `transitivity`                                       | `{value, status, provenance{type, method, source}}`. `value: uncertain` ⇔ `status: needs_review` (validator-enforced). The provenance records that an algorithm/curation produced the assessment; the status records that it is unresolved. |
| `additional_forms`                                   | Three cells, uniform shape below.                                                                                                                                                                                                           |
| `quiz_eligibility`                                   | **Field-level**, see below.                                                                                                                                                                                                                 |
| `data_quality`                                       | `{source_preserved, root_status, derived_fields_status, requires_manual_review, notes}`.                                                                                                                                                    |

### `additional_forms` cell (uniform)

```json
"ism_maful": {
  "value": "مَبْذُوْلٌ",
  "status": "algorithmically_derived",
  "quiz_eligible": false,
  "blocked_by": null,
  "verification_source": null,
  "notes": ["morphologically generated pattern; not checked against a dictionary; not attested usage"]
}
```

- Uncertain-transitivity entries carry `status: "blocked_by_transitivity_review"`,
  `blocked_by: "transitivity"`, `value: null` in all three cells; the entry's
  single transitivity review row explicitly lists the three blocked fields.
- `quiz_eligible: true` requires `status: "verified"` + `verification_source`.
  Currently 750 generated values, 63 blocked placeholders, **0 quiz-eligible**.

### `quiz_eligibility` (field-level)

```json
"quiz_eligibility": {
  "madi": true, "mudari": true, "masdar": true, "meaning": true,
  "ism_fail": true, "amr": true, "nahi": true, "bab": true,
  "verb_type": true, "root": true,
  "generated_additional_forms": false
}
```

- Each source field is individually gated. A review concern disables **only**
  the affected field(s); the validator fails if an unrelated field is disabled
  or an affected field is left enabled.
- `root` is `true` iff `root_status` is `internally_validated`/`verified`.
- Unresolved roots (369 طَاحَ, 372 غَاطَ) disable `root` **and** `verb_type`
  (the wawi/ya'i placement is exactly what is in doubt).
- `generated_additional_forms` stays `false` until the cells are independently
  verified.

### Transcription-note → field mapping (`NOTE_AFFECTED_FIELDS`)

| ids                                            | affected field(s)                                     |
| ---------------------------------------------- | ----------------------------------------------------- |
| 30, 34, 177, 212, 291, 307, 371, 376, 438, 449 | `masdar`                                              |
| 118                                            | `ism_fail`                                            |
| 138                                            | `amr`, `nahi`                                         |
| 454                                            | `mudari`                                              |
| 372                                            | `root`, `verb_type` (folded into its root review row) |

Everything else in those entries — madi, mudari, meaning, bab, root, etc. —
remains quiz-eligible unless separately affected.

## Review-row schema (`data/.review-rows.json`)

```json
{
  "dataset": "mujarrad",
  "id": "138",
  "arabic": "لَبِثَ",
  "field": "amr,nahi",
  "proposed": "اِلْبَثُ / لَا تَلْبَثُ",
  "reason": "the printed source shows an irregular or ambiguous form ...",
  "status": "needs_review",
  "quiz_eligible": false,
  "affected_quiz_fields": ["amr", "nahi"],
  "source_note": "FULL transcription note, never truncated",
  "action": "decide the quiz policy for the affected field(s), then re-enable them"
}
```

- `source_note` must equal the entry's complete `transcription_note`
  (validator-enforced — this is the anti-truncation guarantee), and it may only
  appear on the row that reviews that printed irregularity — e.g. entry 449's
  masdar note sits on its masdar row, not on its transitivity row
  (validator-enforced).
- Transitivity rows use `affected_quiz_fields: ["ism_maful", "madi_passive",
"mudari_passive"]` and state that those forms are blocked by the same issue.
- Root rows use `["root", "verb_type"]`; candidate rows use `["entire_entry"]`.
- The Markdown report is the exact output of the shared builder for these rows.

## Mazid fih files

Patterns: unchanged Forms II–X templates; teaching-safe as _patterns_; no
lexical claims. Candidates: 21 seed entries, ids `mazid-0001`–`mazid-0021`
(sequential-contiguous policy, validator-enforced; treat as opaque strings),
all `needs_review` + `quiz_eligible: false`, with structured provenance; file
metadata declares `incomplete_seed_dataset`, `production_ready: false`,
`coverage_complete: false`.

## How application code must select quiz content

```python
def field_is_quiz_eligible(entry: dict, field_name: str) -> bool:
    eligibility = entry.get("quiz_eligibility", {})
    return eligibility.get(field_name) is True
```

```python
def generated_form_is_quiz_eligible(form: dict) -> bool:
    return (
        form.get("quiz_eligible") is True
        and form.get("status") == "verified"          # independently verified
        and form.get("verification_source") is not None
    )
```

Never quiz a field because its value exists; never interpret free-text notes at
runtime — the booleans and statuses carry the whole decision.

### Current eligibility counts (from `statistics.quiz_eligibility_statistics`)

madi 455 · mudari 454 · masdar 445 · meaning 455 · ism_fail 454 · amr 454 ·
nahi 454 · bab 455 · verb_type 453 · root 453 · generated forms 0 · mazid 0.

## Unicode and Arabic-text handling (mandatory)

Raw UTF-8 (no `\uXXXX`). For strict matching: NFC-normalise, strip invisible
formatting characters (U+200B–U+200F, U+061C, U+FEFF, U+2060), trim — and
nothing else. Keep harakat, shaddah and hamzah-seat distinctions. Never store
normalised strings back. Reference: `normalize_for_comparison()` /
`arabic_equal()` in both scripts. Split masdar alternatives on `" / "`.

## Database import notes

`id` and `mazid-NNNN` are stable keys; cells and `quiz_eligibility` flatten to
columns; `data_quality.requires_manual_review` is a moderation flag;
deterministic output makes release diffs meaningful.
