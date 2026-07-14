#!/usr/bin/env python3
"""Safely extract and verify Arabic source values for Safwa.

Arabic strings must never be copied from visually rendered terminal output
or typed by hand (see CLAUDE.md). This tool reads exact values from the JSON
datasets and reports codepoint-safe evidence:

    python scripts/arabic-extract.py 369 madi
    python scripts/arabic-extract.py 372 mudari
    python scripts/arabic-extract.py --bab nasara
    python scripts/arabic-extract.py --verify-known

Reads  : data/safwa-mujarrad.original.json   (immutable source evidence)
         data/safwa-vocabulary.v2.json       (enriched dataset)
Writes : nothing. Stored values are never normalised or modified; NFC is
         checked, not applied.

Exit codes: 0 = success, 1 = verification failure, 2 = usage or I/O error.
"""
from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
ORIGINAL_FILE = DATA_DIR / "safwa-mujarrad.original.json"
V2_FILE = DATA_DIR / "safwa-vocabulary.v2.json"

SOURCE_FIELDS = [
    "madi", "mudari", "masdar", "meaning", "ism_fail", "amr", "nahi",
    "bab", "bab_arabic", "verb_type", "verb_type_arabic",
]
ARABIC_SOURCE_FIELDS = [
    "madi", "mudari", "masdar", "ism_fail", "amr", "nahi",
    "bab_arabic", "verb_type_arabic",
]
KNOWN_UNRESOLVED_ROOT_IDS = [369, 372]
KNOWN_DUPLICATE_MADI_GROUPS = [(262, 275), (297, 303), (409, 413)]
KNOWN_BABS = ["nasara", "daraba", "samia", "fataha", "karuma", "hasiba"]


class VerificationError(Exception):
    """A check failed; the message is safe to print (ASCII evidence only)."""


def escaped(value: str) -> str:
    r"""Return the \uXXXX escape representation (pure ASCII)."""
    return "".join(f"\\u{ord(ch):04x}" for ch in value)


def codepoint_list(value: str) -> str:
    """Return the U+XXXX form of every codepoint (pure ASCII)."""
    return " ".join(f"U+{ord(ch):04X}" for ch in value)


def load_datasets() -> tuple[dict[int, dict[str, Any]], dict[int, dict[str, Any]]]:
    """Load both datasets keyed by entry id. Raises VerificationError on I/O."""
    try:
        original = json.loads(ORIGINAL_FILE.read_text(encoding="utf-8"))
        enriched = json.loads(V2_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VerificationError(f"cannot read datasets: {exc}") from exc
    return (
        {e["id"]: e for e in original["entries"]},
        {e["id"]: e for e in enriched["mujarrad_entries"]},
    )


def get_field(entries: dict[int, dict[str, Any]], entry_id: int, field: str,
              which: str) -> str:
    if entry_id not in entries:
        raise VerificationError(f"entry {entry_id} not found in {which} dataset")
    if field not in entries[entry_id]:
        raise VerificationError(f"field '{field}' missing on entry {entry_id} in {which} dataset")
    value = entries[entry_id][field]
    if not isinstance(value, str):
        raise VerificationError(f"field '{field}' on entry {entry_id} is not a string")
    return value


def check_value(original: dict[int, dict[str, Any]],
                enriched: dict[int, dict[str, Any]],
                entry_id: int, field: str) -> str:
    """Verify orig==enriched and NFC; return the value. Never modifies it."""
    orig_value = get_field(original, entry_id, field, "original")
    enr_value = get_field(enriched, entry_id, field, "enriched")
    if orig_value != enr_value:
        raise VerificationError(
            f"entry {entry_id} field '{field}': enriched differs from original "
            f"(original={escaped(orig_value)} enriched={escaped(enr_value)})")
    if field in ARABIC_SOURCE_FIELDS and not unicodedata.is_normalized("NFC", orig_value):
        raise VerificationError(
            f"entry {entry_id} field '{field}' is not NFC: {escaped(orig_value)}")
    return orig_value


def print_extraction(entry_id: int, field: str, value: str, matches: bool) -> None:
    nfc = unicodedata.is_normalized("NFC", value)
    print(f"entry_id           : {entry_id}")
    print(f"field              : {field}")
    print(f"logical_string     : {value}")
    print(f"nfc                : {nfc}")
    print(f"codepoint_count    : {len(value)}")
    print(f"codepoints         : {codepoint_list(value)}")
    print(f"escaped            : {escaped(value)}")
    print(f"original==enriched : {matches}")
    print("note               : trust the codepoints/escapes; terminal rendering"
          " of Arabic may be visually reordered")


def extract_entry(entry_id: int, field: str) -> None:
    original, enriched = load_datasets()
    value = check_value(original, enriched, entry_id, field)
    print_extraction(entry_id, field, value, matches=True)


def bab_value(original: dict[int, dict[str, Any]],
              enriched: dict[int, dict[str, Any]], bab: str) -> str:
    """Return the bab_arabic for a bab id, verifying consistency and NFC."""
    orig_values = {e["bab_arabic"] for e in original.values() if e["bab"] == bab}
    if not orig_values:
        raise VerificationError(f"bab '{bab}' has no entries in the original dataset")
    if len(orig_values) != 1:
        raise VerificationError(
            f"bab '{bab}' has inconsistent bab_arabic values in the original: "
            + " | ".join(sorted(escaped(v) for v in orig_values)))
    value = orig_values.pop()
    mismatched = [eid for eid, e in enriched.items()
                  if e["bab"] == bab and e["bab_arabic"] != value]
    if mismatched:
        raise VerificationError(
            f"bab '{bab}': enriched bab_arabic differs from original for ids {sorted(mismatched)}")
    if not unicodedata.is_normalized("NFC", value):
        raise VerificationError(f"bab '{bab}' bab_arabic is not NFC: {escaped(value)}")
    return value


def extract_bab(bab: str) -> None:
    original, enriched = load_datasets()
    value = bab_value(original, enriched, bab)
    count = sum(1 for e in original.values() if e["bab"] == bab)
    print(f"bab                : {bab}  ({count} entries, all consistent)")
    print(f"logical_string     : {value}")
    print(f"nfc                : True")
    print(f"codepoint_count    : {len(value)}")
    print(f"codepoints         : {codepoint_list(value)}")
    print(f"escaped            : {escaped(value)}")
    print(f"original==enriched : True")


def verify_unresolved_root_entries(original: dict[int, dict[str, Any]],
                                   enriched: dict[int, dict[str, Any]]) -> None:
    for entry_id in KNOWN_UNRESOLVED_ROOT_IDS:
        for field in SOURCE_FIELDS:
            value = check_value(original, enriched, entry_id, field)
            if field in ("madi", "mudari"):
                print(f"  ok entry {entry_id} {field:<8} {len(value):>2} cp  {escaped(value)}")
        eligibility = enriched[entry_id].get("quiz_eligibility", {})
        if eligibility.get("root") is not False or eligibility.get("verb_type") is not False:
            raise VerificationError(
                f"entry {entry_id}: root/verb_type must be quiz-ineligible while unresolved")
        print(f"  ok entry {entry_id} root+verb_type quiz-ineligible (unresolved root)")


def verify_babs(original: dict[int, dict[str, Any]],
                enriched: dict[int, dict[str, Any]]) -> None:
    seen = {e["bab"] for e in original.values()}
    if seen != set(KNOWN_BABS):
        raise VerificationError(
            f"expected babs {sorted(KNOWN_BABS)}, dataset has {sorted(seen)}")
    for bab in KNOWN_BABS:
        value = bab_value(original, enriched, bab)
        print(f"  ok bab {bab:<7} {len(value):>2} cp  {escaped(value)}")


def verify_duplicate_groups(original: dict[int, dict[str, Any]],
                            enriched: dict[int, dict[str, Any]]) -> None:
    madi_groups: dict[str, list[int]] = {}
    for eid, e in original.items():
        madi_groups.setdefault(e["madi"], []).append(eid)
    actual = sorted(tuple(sorted(ids)) for ids in madi_groups.values() if len(ids) > 1)
    expected = sorted(KNOWN_DUPLICATE_MADI_GROUPS)
    if actual != expected:
        raise VerificationError(
            f"duplicate-madi groups changed: expected {expected}, found {actual}")
    for ids in expected:
        for eid in ids:
            check_value(original, enriched, eid, "madi")
            check_value(original, enriched, eid, "mudari")
        mudari_values = {original[eid]["mudari"] for eid in ids}
        if len(mudari_values) != len(ids):
            raise VerificationError(
                f"duplicate group {ids}: mudari values are not distinct")
        madi = original[ids[0]]["madi"]
        print(f"  ok duplicate group {ids}  madi {escaped(madi)}  mudari distinct")


def verify_known() -> None:
    original, enriched = load_datasets()
    print("verify-known: entries 369/372 (all source fields, orig==enriched, NFC)")
    verify_unresolved_root_entries(original, enriched)
    print("verify-known: six bab_arabic values (consistent, orig==enriched, NFC)")
    verify_babs(original, enriched)
    print("verify-known: protected duplicate-madi groups")
    verify_duplicate_groups(original, enriched)
    print("ALL KNOWN ARABIC CHECKS PASSED")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract/verify Arabic source values (read-only, codepoint-safe).")
    parser.add_argument("entry_id", nargs="?", type=int,
                        help="entry id (1-455), used with FIELD")
    parser.add_argument("field", nargs="?", choices=SOURCE_FIELDS,
                        help="source field name")
    parser.add_argument("--bab", choices=KNOWN_BABS,
                        help="extract a bab_arabic value by bab id")
    parser.add_argument("--verify-known", action="store_true",
                        help="run the full known-example integrity suite")
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    args = build_parser().parse_args(argv)
    try:
        if args.verify_known:
            verify_known()
        elif args.bab:
            extract_bab(args.bab)
        elif args.entry_id is not None and args.field:
            extract_entry(args.entry_id, args.field)
        else:
            build_parser().print_usage()
            return 2
    except VerificationError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
