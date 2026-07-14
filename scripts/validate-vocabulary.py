#!/usr/bin/env python3
"""Validate the SarfMaster vocabulary data foundation.

Usage:  python scripts/validate-vocabulary.py

Exits non-zero when any check fails.  Checks cover:
  1. original-data preservation (455 entries, every field byte-identical),
  2. root well-formedness and verb-type compatibility,
  3. status integrity: no internal reconstruction may claim independent
     verification; no unverified generated value may be quiz-eligible;
     uncertain transitivity must be needs_review and must block the
     dependent generated forms,
  4. FIELD-LEVEL quiz eligibility: a review concern disables exactly the
     affected field(s) and nothing else; no broad source_forms flag,
  5. review-report integrity: full untruncated source notes, complete
     coverage of every needs_review/blocked item, and exact agreement
     between the JSON rows and the Markdown report,
  6. mazid fih dataset safety (seed status, disabled quizzes, ID policy),
  7. statistics consistency and duplicate-madi protection,
  8. named scenario self-tests for the known review entries.

Shares configuration (NOTE_AFFECTED_FIELDS, SOURCE_QUIZ_FIELDS, the
review-markdown builder) with scripts/enrich-vocabulary.py by importing it,
so the two can never silently drift apart.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
DATA_DIR = ROOT_DIR / "data"
DOCS_DIR = ROOT_DIR / "docs"
ORIGINAL_FILE = DATA_DIR / "safwa-mujarrad.original.json"
V2_FILE = DATA_DIR / "sarfmaster-vocabulary.v2.json"
PATTERNS_FILE = DATA_DIR / "mazid-fih-patterns.json"
CANDIDATES_FILE = DATA_DIR / "mazid-fih-candidates.json"
REVIEW_ROWS_FILE = DATA_DIR / ".review-rows.json"
REVIEW_MD_FILE = DOCS_DIR / "manual-review-required.md"

# import the enrichment module for shared, single-source-of-truth config
_spec = importlib.util.spec_from_file_location(
    "enrichmod", SCRIPT_DIR / "enrich-vocabulary.py")
enrichmod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(enrichmod)

NOTE_AFFECTED_FIELDS = enrichmod.NOTE_AFFECTED_FIELDS
SOURCE_QUIZ_FIELDS = enrichmod.SOURCE_QUIZ_FIELDS
ADDITIONAL_FORM_FIELDS = enrichmod.ADDITIONAL_FORM_FIELDS
ROOT_REVIEW_AFFECTED = enrichmod.ROOT_REVIEW_AFFECTED
build_review_md = enrichmod.build_review_md

HARAKAT = set("ًٌٍَُِّْٰ")
INVISIBLE = set("​‌‍‎‏؜﻿⁠")
ARABIC_RE = re.compile(r"[ء-ي]")
SEATED_HAMZA = set("أإؤئآ")

EXPECTED_BAB_COUNTS = {"nasara": 140, "daraba": 127, "samia": 73,
                       "fataha": 74, "karuma": 35, "hasiba": 6}
EXPECTED_DUPLICATE_GROUPS = {
    "حَبَّ": [262, 275],
    "قَرَأَ": [297, 303],
    "مَحَا": [409, 413],
}
ORIGINAL_FIELDS = ["id", "madi", "mudari", "masdar", "meaning", "ism_fail",
                   "amr", "nahi", "bab", "bab_arabic", "verb_type",
                   "verb_type_arabic", "book_page"]
ROOT_STATUSES = {"verified", "internally_validated", "algorithmically_derived",
                 "needs_review"}
FORM_STATUSES = {"verified", "algorithmically_derived", "needs_review",
                 "blocked_by_transitivity_review", "not_applicable"}
TRANSITIVITY_VALUES = {"transitive", "intransitive", "uncertain"}
TRANSITIVITY_STATUSES = {"curated", "algorithmically_derived", "needs_review"}
VERB_TYPES = {"sahih", "mudaaf", "mahmuz_fa", "mahmuz_ain", "mahmuz_lam",
              "mithal_wawi", "mithal_yai", "ajwaf_wawi", "ajwaf_yai",
              "naqis_wawi", "naqis_yai", "lafif_mafruq", "lafif_maqrun"}
TYPE_WEAK = {"mithal_wawi": (0, "و"), "mithal_yai": (0, "ي"),
             "ajwaf_wawi": (1, "و"), "ajwaf_yai": (1, "ي"),
             "naqis_wawi": (2, "و"), "naqis_yai": (2, "ي")}
ROOT_TYPE_EXCEPTIONS = {372}
QE_KEYS = SOURCE_QUIZ_FIELDS + ["root", "generated_additional_forms"]

failures: list[str] = []
checks = 0


def check(ok: bool, message: str) -> None:
    global checks
    checks += 1
    if not ok:
        failures.append(message)


def norm(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    return "".join(ch for ch in text if ch not in INVISIBLE).strip()


def main() -> int:
    for path in (ORIGINAL_FILE, V2_FILE, PATTERNS_FILE, CANDIDATES_FILE,
                 REVIEW_ROWS_FILE, REVIEW_MD_FILE):
        if not path.exists():
            print(f"FAIL: missing file {path}")
            return 1

    original = json.loads(ORIGINAL_FILE.read_text(encoding="utf-8"))
    v2 = json.loads(V2_FILE.read_text(encoding="utf-8"))
    patterns_doc = json.loads(PATTERNS_FILE.read_text(encoding="utf-8"))
    candidates_doc = json.loads(CANDIDATES_FILE.read_text(encoding="utf-8"))
    review_rows = json.loads(REVIEW_ROWS_FILE.read_text(encoding="utf-8"))
    review_md = REVIEW_MD_FILE.read_text(encoding="utf-8")

    orig_entries = original["entries"]
    entries = v2["mujarrad_entries"]
    cands = v2["mazid_fih_entries"]
    stats = v2["statistics"]

    check(v2.get("schema_version") == "2.2.0", "schema_version != 2.2.0")

    # ------------------------------------------------------------------
    # 1. Original-data preservation
    # ------------------------------------------------------------------
    check(len(orig_entries) == 455, f"original entries {len(orig_entries)} != 455")
    check(len(entries) == 455, f"enriched entries {len(entries)} != 455")

    orig_by_id = {e["id"]: e for e in orig_entries}
    check(len(orig_by_id) == 455, "duplicate ids inside original file")
    enr_by_id: dict[int, dict[str, Any]] = {}
    for e in entries:
        check(e["id"] not in enr_by_id, f"duplicate enriched id {e['id']}")
        enr_by_id[e["id"]] = e
    check(set(orig_by_id) == set(enr_by_id),
          "enriched ids differ from original ids")

    for oid, oe in orig_by_id.items():
        ee = enr_by_id.get(oid)
        if ee is None:
            continue
        for field in ORIGINAL_FIELDS:
            check(ee.get(field) == oe.get(field),
                  f"id {oid}: original field {field!r} changed: "
                  f"{oe.get(field)!r} -> {ee.get(field)!r}")
        if "transcription_note" in oe:
            check(ee.get("transcription_note") == oe["transcription_note"],
                  f"id {oid}: transcription_note lost or changed")

    note_count = sum(1 for e in entries if "transcription_note" in e)
    check(note_count == 14, f"transcription notes {note_count} != 14")

    bab_counts = Counter(e["bab"] for e in entries)
    for bab, expected in EXPECTED_BAB_COUNTS.items():
        check(bab_counts.get(bab) == expected,
              f"bab {bab}: {bab_counts.get(bab)} != {expected}")

    # ------------------------------------------------------------------
    # 2. Root validation
    # ------------------------------------------------------------------
    for e in entries:
        eid = e["id"]
        letters = e["root_letters"]
        check(isinstance(letters, list) and len(letters) == 3,
              f"id {eid}: root_letters must have exactly 3 items: {letters}")
        check(e["root"] == " ".join(letters),
              f"id {eid}: root does not match root_letters")
        check(e["root_compact"] == "".join(letters),
              f"id {eid}: root_compact does not match root_letters")
        joined = "".join(letters)
        check(not (set(joined) & HARAKAT),
              f"id {eid}: root contains harakat: {joined}")
        check("ا" not in joined,
              f"id {eid}: root uses alif in place of a weak radical: {joined}")
        check(not (set(joined) & SEATED_HAMZA),
              f"id {eid}: root uses a seated hamzah, expected ء: {joined}")
        vt = e["verb_type"]
        check(vt in VERB_TYPES, f"id {eid}: unknown verb_type {vt}")
        if vt == "mudaaf":
            check(letters[1] == letters[2],
                  f"id {eid}: mudaaf root must repeat final radical: {joined}")
        if vt in ("mahmuz_fa", "mahmuz_ain", "mahmuz_lam"):
            pos = {"mahmuz_fa": 0, "mahmuz_ain": 1, "mahmuz_lam": 2}[vt]
            check(letters[pos] == "ء",
                  f"id {eid}: {vt} root lacks ء at position {pos}: {joined}")
        if vt in TYPE_WEAK and eid not in ROOT_TYPE_EXCEPTIONS:
            pos, letter = TYPE_WEAK[vt]
            check(letters[pos] == letter,
                  f"id {eid}: {vt} root should have {letter} at {pos}: {joined}")
        if eid in ROOT_TYPE_EXCEPTIONS:
            check(e["data_quality"]["root_status"] == "needs_review",
                  f"id {eid}: type-exception root must stay needs_review")
        if vt == "lafif_mafruq":
            check(letters[0] == "و" and letters[2] == "ي",
                  f"id {eid}: lafif mafruq root shape unexpected: {joined}")
        if vt == "lafif_maqrun":
            check(letters[1] in ("و", "ي") and letters[2] == "ي",
                  f"id {eid}: lafif maqrun root shape unexpected: {joined}")

    # ------------------------------------------------------------------
    # 3. Status integrity + schema validation (enriched entries)
    # ------------------------------------------------------------------
    for e in entries:
        eid = e["id"]
        check(e.get("form_number") == 1, f"id {eid}: form_number != 1")
        check(e.get("form_type") == "thulathi_mujarrad",
              f"id {eid}: form_type unexpected")

        dq = e.get("data_quality")
        rp = e.get("root_provenance")
        check(isinstance(dq, dict), f"id {eid}: missing data_quality")
        check(isinstance(rp, dict) and set(rp) == {"type", "method", "source",
                                                   "reviewed_by"},
              f"id {eid}: root_provenance malformed")
        if not isinstance(dq, dict) or not isinstance(rp, dict):
            continue
        root_status = dq.get("root_status")
        check(dq.get("source_preserved") is True,
              f"id {eid}: source_preserved is not true")
        check(root_status in ROOT_STATUSES,
              f"id {eid}: bad root_status {root_status}")
        check(rp.get("type") == root_status,
              f"id {eid}: root_provenance.type != root_status")
        if root_status == "verified":
            check(bool(rp.get("source")) and bool(rp.get("reviewed_by")),
                  f"id {eid}: root_status verified without provenance "
                  "source/reviewed_by")
        check(dq.get("derived_fields_status") in FORM_STATUSES,
              f"id {eid}: bad derived_fields_status")
        check(isinstance(dq.get("requires_manual_review"), bool),
              f"id {eid}: requires_manual_review not boolean")

        tr = e.get("transitivity")
        check(isinstance(tr, dict)
              and tr.get("value") in TRANSITIVITY_VALUES
              and tr.get("status") in TRANSITIVITY_STATUSES
              and isinstance(tr.get("provenance"), dict)
              and set(tr["provenance"]) == {"type", "method", "source"},
              f"id {eid}: bad transitivity {tr}")
        if isinstance(tr, dict):
            # unresolved transitivity must be a review item, and vice versa
            check((tr.get("value") == "uncertain")
                  == (tr.get("status") == "needs_review"),
                  f"id {eid}: transitivity value/status inconsistent: {tr}")

        af = e.get("additional_forms")
        check(isinstance(af, dict) and set(af) == set(ADDITIONAL_FORM_FIELDS),
              f"id {eid}: additional_forms keys wrong")
        if isinstance(af, dict):
            for name, cell in af.items():
                check(isinstance(cell, dict)
                      and set(cell) == {"value", "status", "quiz_eligible",
                                        "blocked_by", "verification_source",
                                        "notes"},
                      f"id {eid}: additional_forms.{name} malformed")
                if not isinstance(cell, dict):
                    continue
                value, status = cell.get("value"), cell.get("status")
                check(status in FORM_STATUSES,
                      f"id {eid}: {name} bad status {status}")
                check(isinstance(cell.get("quiz_eligible"), bool),
                      f"id {eid}: {name} quiz_eligible not boolean")
                check(value is None or (isinstance(value, str) and value.strip()),
                      f"id {eid}: {name} empty string (must be null or real)")
                if isinstance(value, str):
                    check(bool(ARABIC_RE.search(value)),
                          f"id {eid}: {name} not Arabic: {value!r}")
                    check(status not in ("not_applicable",
                                         "blocked_by_transitivity_review"),
                          f"id {eid}: {name} has value but status {status}")
                if value is None:
                    check(status in ("not_applicable", "needs_review",
                                     "blocked_by_transitivity_review"),
                          f"id {eid}: {name} null but status {status}")
                if cell["quiz_eligible"]:
                    check(status == "verified" and bool(cell.get("verification_source")),
                          f"id {eid}: {name} quiz_eligible while status={status}")
                if status == "verified":
                    check(bool(cell.get("verification_source")),
                          f"id {eid}: {name} verified without verification_source")
                if status in ("needs_review", "blocked_by_transitivity_review"):
                    check(cell["quiz_eligible"] is False,
                          f"id {eid}: {name} {status} but quiz_eligible")
                # blocked-status consistency
                if status == "blocked_by_transitivity_review":
                    check(cell.get("blocked_by") == "transitivity",
                          f"id {eid}: {name} blocked status without "
                          "blocked_by=transitivity")
                    check(tr.get("value") == "uncertain",
                          f"id {eid}: {name} blocked but transitivity resolved")
                else:
                    check(cell.get("blocked_by") is None,
                          f"id {eid}: {name} blocked_by set without blocked status")
            if tr.get("value") == "uncertain":
                check(all(af[k]["status"] == "blocked_by_transitivity_review"
                          for k in ADDITIONAL_FORM_FIELDS),
                      f"id {eid}: uncertain transitivity but forms not blocked")

        # ---- FIELD-LEVEL quiz eligibility --------------------------------
        qe = e.get("quiz_eligibility")
        check(isinstance(qe, dict) and list(qe) == QE_KEYS
              and all(isinstance(v, bool) for v in qe.values()),
              f"id {eid}: quiz_eligibility must have field-level keys "
              f"{QE_KEYS}, got {qe}")
        check(not isinstance(qe, dict) or "source_forms" not in qe,
              f"id {eid}: broad source_forms flag still present")
        if isinstance(qe, dict):
            expected_disabled = set(NOTE_AFFECTED_FIELDS.get(eid, []))
            if root_status == "needs_review":
                expected_disabled |= {"root", "verb_type"}
            for f in SOURCE_QUIZ_FIELDS:
                check(qe[f] == (f not in expected_disabled),
                      f"id {eid}: field {f} eligibility {qe[f]} but expected "
                      f"{f not in expected_disabled} (a concern must disable "
                      "exactly the affected fields, nothing else)")
            check(qe["root"] == (root_status in ("internally_validated",
                                                 "verified")),
                  f"id {eid}: root eligibility inconsistent with status "
                  f"{root_status}")
            check(qe["generated_additional_forms"] is False
                  or all(af[k]["quiz_eligible"] and af[k]["status"] == "verified"
                         for k in ADDITIONAL_FORM_FIELDS),
                  f"id {eid}: generated forms eligible without verification")

        for field in ("madi", "mudari", "masdar", "ism_fail", "amr", "nahi"):
            check(bool(ARABIC_RE.search(e[field])),
                  f"id {eid}: field {field} contains no Arabic")
        check(isinstance(e["meaning"], str) and e["meaning"].strip() != "",
              f"id {eid}: meaning blank")

    # ------------------------------------------------------------------
    # 4. Pattern catalogue validation (templates, never lexical entries)
    # ------------------------------------------------------------------
    plist = patterns_doc["patterns"]
    check(patterns_doc.get("dataset_status") == "pattern_templates",
          "patterns file must declare dataset_status=pattern_templates")
    check(patterns_doc.get("lexical_claims") is False,
          "patterns file must declare lexical_claims=false")
    check(len(plist) == 9, f"pattern count {len(plist)} != 9 (Forms II-X)")
    check([p["form_number"] for p in plist] == list(range(2, 11)),
          "pattern form_numbers are not 2..10")
    for p in plist:
        for key in ("form_label", "arabic_name", "madi_pattern",
                    "mudari_pattern", "masdar_patterns", "ism_fail_pattern",
                    "ism_maful_pattern", "amr_pattern", "general_meanings",
                    "notes"):
            check(key in p, f"pattern {p.get('form_number')}: missing {key}")
        check(isinstance(p["masdar_patterns"], list) and p["masdar_patterns"],
              f"pattern {p['form_number']}: masdar_patterns empty")
    check(v2["mazid_fih_patterns"] == plist,
          "patterns differ between v2 file and patterns file")

    # ------------------------------------------------------------------
    # 5. Candidate validation (seed dataset safety + ID policy)
    # ------------------------------------------------------------------
    check(candidates_doc["candidates"] == cands,
          "candidates differ between v2 file and candidates file")
    check(candidates_doc.get("dataset_status") == "incomplete_seed_dataset",
          "candidates file must declare dataset_status=incomplete_seed_dataset")
    check(candidates_doc.get("coverage_complete") is False,
          "candidates file must not claim complete coverage")
    check(isinstance(candidates_doc.get("id_policy"), str),
          "candidates file missing id_policy statement")
    any_unverified = any(c["verification_status"] != "verified" for c in cands)
    if any_unverified:
        check(candidates_doc.get("production_ready") is False,
              "candidates file claims production readiness while candidates "
              "remain unverified")
        check(candidates_doc.get("quiz_eligible") is False,
              "candidates file claims quiz eligibility while candidates "
              "remain unverified")

    pattern_madis = {p["madi_pattern"] for p in plist}
    valid_ids = set(enr_by_id)
    root_by_id = {e["id"]: e["root_compact"] for e in entries}
    seen_cand_ids: list[str] = []
    for c in cands:
        cid = c["id"]
        seen_cand_ids.append(cid)
        check(re.fullmatch(r"mazid-\d{4}", cid) is not None,
              f"candidate id format unexpected: {cid}")
        check(2 <= c["form_number"] <= 10,
              f"{cid}: form_number {c['form_number']} outside 2..10")
        check(c["root"] == " ".join(c["root_letters"]), f"{cid}: root mismatch")
        check(c["verification_status"] in ("verified", "needs_review"),
              f"{cid}: bad verification_status")
        prov = c.get("provenance")
        check(isinstance(prov, dict) and set(prov) == {"type", "method",
                                                       "source", "reviewed_by"},
              f"{cid}: provenance malformed")
        if c["verification_status"] == "verified":
            check(bool(prov.get("source")),
                  f"{cid}: verified without provenance source")
        else:
            check(c["quiz_eligible"] is False,
                  f"{cid}: needs_review candidate is quiz-eligible")
        check(c["related_mujarrad_entry_ids"], f"{cid}: no related mujarrad ids")
        for rid in c["related_mujarrad_entry_ids"]:
            check(rid in valid_ids, f"{cid}: related id {rid} not in dataset")
            check(root_by_id.get(rid) == c["root_compact"],
                  f"{cid}: related id {rid} has different root")
        check(c["madi"] not in pattern_madis and c["root_compact"] != "فعل",
              f"{cid}: pattern template stored as lexical entry")

    expected_ids = [f"mazid-{i:04d}" for i in range(1, len(cands) + 1)]
    check(seen_cand_ids == expected_ids,
          f"candidate ids violate the sequential-contiguous policy")

    # ------------------------------------------------------------------
    # 6. Review-report integrity (full notes, coverage, md/json agreement)
    # ------------------------------------------------------------------
    ROW_COLUMNS = {"dataset", "id", "arabic", "field", "proposed", "reason",
                   "status", "quiz_eligible", "affected_quiz_fields",
                   "source_note", "action"}
    row_keys = {(r["dataset"], str(r["id"]), r["field"]) for r in review_rows}
    check(len(row_keys) == len(review_rows), "duplicate review rows")
    for r in review_rows:
        check(set(r) == ROW_COLUMNS,
              f"review row {r.get('id')}/{r.get('field')}: columns wrong")
        check(r.get("status") == "needs_review",
              f"review row {r.get('id')}/{r.get('field')}: status not needs_review")
        check(r.get("quiz_eligible") is False,
              f"review row {r.get('id')}/{r.get('field')}: quiz_eligible true")
        check(isinstance(r.get("affected_quiz_fields"), list)
              and r["affected_quiz_fields"],
              f"review row {r.get('id')}/{r.get('field')}: affected fields empty")
        # truncation guards: no trailing ellipsis, no cut Arabic
        for col in ("proposed", "reason", "action"):
            check(not str(r.get(col, "")).rstrip().endswith(("…", "...")),
                  f"review row {r.get('id')}/{col}: looks truncated")
        # a row's source_note must be the FULL transcription note
        if r["dataset"] == "mujarrad" and r.get("source_note") is not None:
            entry = enr_by_id.get(int(r["id"]))
            check(entry is not None
                  and r["source_note"] == entry.get("transcription_note"),
                  f"review row {r['id']}/{r['field']}: source_note is not the "
                  "full transcription note")
            # a source_note may only sit on the row that reviews that printed
            # irregularity - never on an unrelated row of the same entry
            mapped = set(NOTE_AFFECTED_FIELDS.get(int(r["id"]), []))
            check(bool(mapped)
                  and set(r["affected_quiz_fields"]) <= mapped,
                  f"review row {r['id']}/{r['field']}: carries a source_note "
                  "unrelated to its own concern")

    for e in entries:
        eid = str(e["id"])
        if e["data_quality"]["root_status"] == "needs_review":
            root_rows = [r for r in review_rows
                         if r["dataset"] == "mujarrad" and r["id"] == eid
                         and r["field"] == "root"]
            check(len(root_rows) == 1,
                  f"id {eid}: root needs_review missing from review rows")
            if root_rows:
                check(root_rows[0]["affected_quiz_fields"] == ROOT_REVIEW_AFFECTED,
                      f"id {eid}: root row affected fields wrong")
        if e["transitivity"]["value"] == "uncertain":
            t_rows = [r for r in review_rows
                      if r["dataset"] == "mujarrad" and r["id"] == eid
                      and r["field"] == "transitivity"]
            check(len(t_rows) == 1,
                  f"id {eid}: uncertain transitivity missing from review rows")
            if t_rows:
                check(t_rows[0]["affected_quiz_fields"] == ADDITIONAL_FORM_FIELDS,
                      f"id {eid}: transitivity row must list the blocked forms")
                check("blocked" in t_rows[0]["reason"],
                      f"id {eid}: transitivity row must state that the "
                      "dependent forms are blocked by the same issue")
        if e["data_quality"]["derived_fields_status"] == "needs_review":
            check(("mujarrad", eid, "additional_forms") in row_keys,
                  f"id {eid}: additional forms needs_review missing from rows")
        if "transcription_note" in e:
            noted = [r for r in review_rows
                     if r["dataset"] == "mujarrad" and r["id"] == eid
                     and r.get("source_note") == e["transcription_note"]]
            check(bool(noted),
                  f"id {eid}: no review row carries the full transcription note")
            # the note's affected fields must be disabled, and covered by a row
            mapped = NOTE_AFFECTED_FIELDS.get(e["id"], [])
            covered = {f for r in review_rows
                       if r["dataset"] == "mujarrad" and r["id"] == eid
                       for f in r["affected_quiz_fields"]}
            for f in mapped:
                check(f in covered,
                      f"id {eid}: noted field {f} lacks review coverage")
        if e["data_quality"]["requires_manual_review"]:
            check(any(k[0] == "mujarrad" and k[1] == eid for k in row_keys),
                  f"id {eid}: requires_manual_review but no review row")
    for c in cands:
        if c["verification_status"] == "needs_review":
            crows = [r for r in review_rows
                     if r["dataset"] == "mazid_fih" and r["id"] == c["id"]]
            check(len(crows) == 1 and crows[0]["field"] == "entire_entry"
                  and crows[0]["affected_quiz_fields"] == ["entire_entry"],
                  f"{c['id']}: candidate review row missing or malformed")

    # the Markdown report must be EXACTLY what the builder produces for the
    # current rows: catches truncation, drift and disagreement in one shot
    check(review_md == build_review_md(review_rows),
          "manual-review-required.md is not the exact render of "
          ".review-rows.json (regenerate with the enrichment script)")

    # ------------------------------------------------------------------
    # 7. Statistics consistency (all produced from the actual records)
    # ------------------------------------------------------------------
    root_sc = Counter(e["data_quality"]["root_status"] for e in entries)
    gen_vals = [f for e in entries for f in e["additional_forms"].values()
                if f["value"] is not None]
    blocked_vals = [f for e in entries for f in e["additional_forms"].values()
                    if f["status"] == "blocked_by_transitivity_review"]
    elig = {f"{field}_eligible": sum(1 for e in entries
                                     if e["quiz_eligibility"][field])
            for field in SOURCE_QUIZ_FIELDS}
    elig["root_eligible"] = sum(1 for e in entries if e["quiz_eligibility"]["root"])
    elig["generated_additional_forms_eligible"] = sum(
        1 for e in entries if e["quiz_eligibility"]["generated_additional_forms"])
    elig["mazid_fih_entries_eligible"] = sum(1 for c in cands if c["quiz_eligible"])
    expected_stats = {
        "mujarrad_entry_count": len(entries),
        "entries_per_bab": dict(bab_counts),
        "entries_per_verb_type": dict(Counter(e["verb_type"] for e in entries)),
        "entries_with_transcription_notes": note_count,
        "roots_independently_verified": root_sc.get("verified", 0),
        "roots_internally_validated": root_sc.get("internally_validated", 0),
        "roots_algorithmically_derived": root_sc.get("algorithmically_derived", 0),
        "roots_requiring_review": root_sc.get("needs_review", 0),
        "entries_with_generated_additional_forms": sum(
            1 for e in entries
            if any(f["value"] for f in e["additional_forms"].values())),
        "generated_additional_form_values": len(gen_vals),
        "generated_additional_forms_quiz_eligible": sum(
            1 for f in gen_vals if f["quiz_eligible"]),
        "additional_form_values_blocked_by_transitivity": len(blocked_vals),
        "entries_requiring_manual_review": sum(
            1 for e in entries if e["data_quality"]["requires_manual_review"]),
        "transitivity": dict(Counter(e["transitivity"]["value"] for e in entries)),
        "quiz_eligibility_statistics": elig,
        "mazid_fih_pattern_count": len(plist),
        "mazid_fih_candidate_count": len(cands),
        "mazid_fih_candidates_by_form": dict(sorted(
            Counter(c["form_label"] for c in cands).items())),
        "mazid_fih_candidates_verified": sum(
            1 for c in cands if c["verification_status"] == "verified"),
        "mazid_fih_candidates_requiring_review": sum(
            1 for c in cands if c["verification_status"] == "needs_review"),
        "mazid_fih_candidates_quiz_eligible": sum(
            1 for c in cands if c["quiz_eligible"]),
        "manual_review_row_count": len(review_rows),
    }
    for key, expected in expected_stats.items():
        check(stats.get(key) == expected,
              f"stats mismatch {key}: file={stats.get(key)!r} actual={expected!r}")
    check(set(stats) == set(expected_stats),
          f"stats keys differ: extra={set(stats) - set(expected_stats)}, "
          f"missing={set(expected_stats) - set(stats)}")

    # ------------------------------------------------------------------
    # 8. Duplicate-madi protection + UTF-8 sanity
    # ------------------------------------------------------------------
    for madi, ids in EXPECTED_DUPLICATE_GROUPS.items():
        found = [e["id"] for e in entries if norm(e["madi"]) == norm(madi)]
        check(sorted(found) == ids,
              f"duplicate group {madi}: expected ids {ids}, found {found}")
        mudaris = {enr_by_id[i]["mudari"] for i in ids if i in enr_by_id}
        check(len(mudaris) == len(ids),
              f"duplicate group {madi}: mudari values collapsed: {mudaris}")

    raw = V2_FILE.read_text(encoding="utf-8")
    check(ARABIC_RE.search(raw) is not None,
          "v2 file contains no raw Arabic (escaped output?)")
    check("\\u06" not in raw, "v2 file contains \\uXXXX-escaped Arabic")

    # ------------------------------------------------------------------
    # 9. Named scenario self-tests (spec-required regression cases)
    # ------------------------------------------------------------------
    def disabled_source_fields(eid: int) -> set[str]:
        qe = enr_by_id[eid]["quiz_eligibility"]
        return {f for f in SOURCE_QUIZ_FIELDS if not qe[f]}

    check(disabled_source_fields(30) == {"masdar"},
          "scenario: id 30 must disable only masdar")
    check(disabled_source_fields(118) == {"ism_fail"},
          "scenario: id 118 must disable only ism_fail")
    check(disabled_source_fields(138) == {"amr", "nahi"},
          "scenario: id 138 must disable only amr and nahi")
    check(disabled_source_fields(454) == {"mudari"},
          "scenario: id 454 must disable only mudari")
    check(disabled_source_fields(1) == set(),
          "scenario: id 1 (clean entry) must disable nothing")
    for rid in (369, 372):
        check(enr_by_id[rid]["quiz_eligibility"]["root"] is False
              and enr_by_id[rid]["quiz_eligibility"]["verb_type"] is False,
              f"scenario: id {rid} unresolved root must disable root+verb_type")
    e202 = enr_by_id[202]
    check(e202["transitivity"]["status"] == "needs_review"
          and all(e202["additional_forms"][k]["status"]
                  == "blocked_by_transitivity_review"
                  for k in ADDITIONAL_FORM_FIELDS),
          "scenario: id 202 uncertain transitivity must block all three forms")
    check(any(r["id"] == "mazid-0001" and r["dataset"] == "mazid_fih"
              for r in review_rows),
          "scenario: candidate mazid-0001 must have a review row")
    full_138 = enr_by_id[138]["transcription_note"]
    check(len(full_138) > 80 and full_138 in review_md.replace("/", "|")
          or full_138.replace("|", "/") in review_md,
          "scenario: id 138 full note must appear untruncated in the report")

    # ------------------------------------------------------------------
    print(f"checks run: {checks}")
    if failures:
        print(f"FAILURES: {len(failures)}")
        for f in failures[:60]:
            print("  -", f)
        if len(failures) > 60:
            print(f"  ... and {len(failures) - 60} more")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
