#!/usr/bin/env python3
"""Enrich the Safwa-tul-Masaadir mujarrad dataset for SarfMaster.

Reads  : data/safwa-mujarrad.original.json   (never modified)
Writes : data/sarfmaster-vocabulary.v2.json
         data/mazid-fih-patterns.json
         data/mazid-fih-candidates.json
         data/.review-rows.json
         docs/manual-review-required.md

Deterministic and idempotent: running twice produces identical content
except for the explicitly generated `generated_at` timestamp.

Provenance and safety policy (see docs/vocabulary-schema.md):
- Original source fields are copied through unchanged, never edited.
- `verified` / `independently_verified` labels are RESERVED for values
  checked against an external authoritative source with recorded
  provenance. Nothing in this dataset currently qualifies.
- Roots that pass internal cross-checks are `internally_validated`.
- Quiz eligibility is FIELD-LEVEL: a transcription concern disables only
  the exact field(s) it affects (see NOTE_AFFECTED_FIELDS), never the
  whole entry.
- Uncertain transitivity is `needs_review`, and the dependent generated
  forms are explicitly `blocked_by_transitivity_review`.
- Every generated value is quiz-ineligible until independently verified.
- Every unresolved item appears in the manual-review report (markdown +
  machine-readable) with its FULL untruncated source note.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# --------------------------------------------------------------------------
# Paths (script-relative so the tool runs from any cwd)
# --------------------------------------------------------------------------
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
DOCS_DIR = ROOT_DIR / "docs"
ORIGINAL_FILE = DATA_DIR / "safwa-mujarrad.original.json"
V2_FILE = DATA_DIR / "sarfmaster-vocabulary.v2.json"
PATTERNS_FILE = DATA_DIR / "mazid-fih-patterns.json"
CANDIDATES_FILE = DATA_DIR / "mazid-fih-candidates.json"
REVIEW_ROWS_FILE = DATA_DIR / ".review-rows.json"
REVIEW_MD_FILE = DOCS_DIR / "manual-review-required.md"

SCHEMA_VERSION = "2.2.0"

# Source fields that can be quizzed individually (field-level eligibility).
SOURCE_QUIZ_FIELDS = ["madi", "mudari", "masdar", "meaning", "ism_fail",
                      "amr", "nahi", "bab", "verb_type"]

# --------------------------------------------------------------------------
# Field-level mapping of the 14 transcription notes.
# Each printed irregularity disables ONLY the field(s) it concerns; every
# other field of the entry stays quiz-eligible. Mapping rationale:
#   30 صَدَرَ   masdar printed with bare alif            -> masdar
#   34 عَرَكَ   masdar printed with bare alif            -> masdar
#  118 سَعِدَ   ism fail printed as sifah سَعِيْدٌ         -> ism_fail
#  138 لَبِثَ   amr and nahi printed with final damma    -> amr, nahi
#  177 طَبَخَ   masdar printed without shadda            -> masdar
#  212 عَظُمَ   masdar printed with sukun on ظ           -> masdar
#  291 سَئِمَ   masdar hamza vowel small in print        -> masdar
#  307 بَطُؤَ   masdar hamza seat read as line hamza     -> masdar
#  371 نَامَ   masdar alif printed without fatha        -> masdar
#  372 غَاطَ   wawi/ya'i classification conflict        -> root, verb_type
#              (folded into the root review row; see ROOT_OVERRIDES)
#  376 تَاهَ   masdar shadda vowel ambiguous            -> masdar
#  438 عَمِيَ   masdar final letter/vowel very small     -> masdar
#  449 وَجِيَ   masdar final letter/vowel very small     -> masdar
#  454 عَيِيَ   mudari printed in contracted spelling    -> mudari
# --------------------------------------------------------------------------
NOTE_AFFECTED_FIELDS: dict[int, list[str]] = {
    30: ["masdar"],
    34: ["masdar"],
    118: ["ism_fail"],
    138: ["amr", "nahi"],
    177: ["masdar"],
    212: ["masdar"],
    291: ["masdar"],
    307: ["masdar"],
    371: ["masdar"],
    372: ["root", "verb_type"],
    376: ["masdar"],
    438: ["masdar"],
    449: ["masdar"],
    454: ["mudari"],
}

# Root-review entries also cast doubt on the printed wawi/ya'i section
# placement, so their verb_type quiz is disabled together with the root.
ROOT_REVIEW_AFFECTED = ["root", "verb_type"]

# --------------------------------------------------------------------------
# Arabic text utilities (documented in docs/vocabulary-schema.md, Unicode)
# --------------------------------------------------------------------------
HARAKAT = "ًٌٍَُِّْٰ"  # tanween, harakat, shadda, sukun, dagger alif
INVISIBLE = "​‌‍‎‏؜﻿⁠"
HAMZA_SEATS = {"أ": "ء", "إ": "ء", "ؤ": "ء", "ئ": "ء", "آ": "ء"}
WEAK = {"و", "ي"}


def normalize_for_comparison(text: str) -> str:
    """Prepare an Arabic string for strict comparison.

    NFC-normalises, strips invisible formatting characters and outer
    whitespace.  Harakat, shaddah and hamzah seats are all PRESERVED:
    they are meaningful in this dataset.  Never store the result back
    into display fields - comparison time only.
    """
    text = unicodedata.normalize("NFC", text)
    text = "".join(ch for ch in text if ch not in INVISIBLE)
    return text.strip()


def arabic_equal(a: str, b: str) -> bool:
    """Strict equality after safe normalisation (harakat significant)."""
    return normalize_for_comparison(a) == normalize_for_comparison(b)


def first_variant(text: str) -> str:
    """Return the first alternative of a ' / '-joined cell."""
    return text.split(" / ")[0].strip()


def skeleton(text: str) -> str:
    """Consonant skeleton: harakat/dagger-alif/tatweel/spaces removed.
    Hamza seats are NOT folded here; see `fold_hamza`."""
    return re.sub(f"[{HARAKAT}ـ ]", "", first_variant(text))


def fold_hamza(text: str) -> str:
    """Fold every hamzah seat to bare hamzah for root work."""
    return "".join(HAMZA_SEATS.get(ch, ch) for ch in text)


# --------------------------------------------------------------------------
# Root derivation
# --------------------------------------------------------------------------
# Curated overrides for entries where a general rule is not safe.
# id -> (root_letters, root_status, reason-for-review-or-None)
ROOT_OVERRIDES: dict[int, tuple[list[str], str, Optional[str]]] = {
    # 372 غَاطَ: printed under the ajwaf ya'i section with a نَصَرَ heading, but
    # the printed mudari يَغُوْطُ shows waw while the printed masdar اَلْغَيْطُ
    # shows ya. Classical dictionaries attest both غ-و-ط and غ-ي-ط for this
    # sense. We retain غ و ط as the proposal (following the mudari) but the
    # conflict stays needs_review until an authoritative source is checked
    # and cited here.
    372: (["غ", "و", "ط"], "needs_review",
          "book classifies as ajwaf ya'i (masdar اَلْغَيْطُ) but prints mudari "
          "يَغُوْطُ with waw; root could be غ و ط or غ ي ط"),
}

# Third radical of naqis / lafif entries comes from the book's own
# wawi/ya'i classification, NOT from the surface letter.  This is the
# classical analysis: e.g. رَضِيَ (root ر ض و: waw shown in اَلرِّضْوَانُ) is
# printed under the naqis wawi section, and نَهُوَ (root ن ه ي: ya shown in
# اَلنِّهَايَةُ) under naqis ya'i, because a final ya becomes waw in فَعُلَ.
TYPE_WEAK_LETTER = {
    "mithal_wawi": "و",
    "mithal_yai": "ي",
    "ajwaf_wawi": "و",
    "ajwaf_yai": "ي",
    "naqis_wawi": "و",
    "naqis_yai": "ي",
}

ROOT_METHOD = ("root reconstruction from the printed madi plus the book's "
               "verb-type classification; re-derived from the mudari where a "
               "clean template exists; weak/hamza radicals required to be "
               "visibly attested in the printed forms (non-radical prefixes "
               "stripped); ajwaf middle-letter conflict detection")


class RootError(Exception):
    pass


def derive_root_from_madi(madi: str, verb_type: str) -> list[str]:
    """Derive the three radicals from the madi plus the book's verb type."""
    sk = fold_hamza(skeleton(madi))
    if verb_type == "sahih":
        if len(sk) != 3:
            raise RootError(f"sahih madi skeleton not 3 letters: {sk!r}")
        return list(sk)
    if verb_type == "mudaaf":
        if len(sk) == 2:
            return [sk[0], sk[1], sk[1]]
        if len(sk) == 3 and sk[1] == sk[2]:
            return list(sk)
        raise RootError(f"mudaaf madi skeleton unexpected: {sk!r}")
    if verb_type in ("mahmuz_fa", "mahmuz_ain", "mahmuz_lam"):
        if len(sk) != 3:
            raise RootError(f"mahmuz madi skeleton not 3 letters: {sk!r}")
        pos = {"mahmuz_fa": 0, "mahmuz_ain": 1, "mahmuz_lam": 2}[verb_type]
        if sk[pos] != "ء":
            raise RootError(f"mahmuz {verb_type} without hamzah in place: {sk!r}")
        return list(sk)
    if verb_type in ("mithal_wawi", "mithal_yai"):
        if len(sk) != 3 or sk[0] != TYPE_WEAK_LETTER[verb_type]:
            raise RootError(f"mithal madi skeleton unexpected: {sk!r}")
        return list(sk)
    if verb_type in ("ajwaf_wawi", "ajwaf_yai"):
        if len(sk) != 3 or sk[1] != "ا":
            raise RootError(f"ajwaf madi skeleton unexpected: {sk!r}")
        return [sk[0], TYPE_WEAK_LETTER[verb_type], sk[2]]
    if verb_type in ("naqis_wawi", "naqis_yai"):
        if len(sk) != 3 or sk[2] not in ("ا", "ى", "ي", "و"):
            raise RootError(f"naqis madi skeleton unexpected: {sk!r}")
        return [sk[0], sk[1], TYPE_WEAK_LETTER[verb_type]]
    if verb_type == "lafif_mafruq":
        # weak fa and weak lam: وَلِيَ / وَفٰى -> و C ي
        if len(sk) != 3 or sk[0] != "و":
            raise RootError(f"lafif mafruq madi skeleton unexpected: {sk!r}")
        return [sk[0], sk[1], "ي"]
    if verb_type == "lafif_maqrun":
        # weak ain and weak lam: رَوٰى، عَيِيَ -> C و/ي ي
        if len(sk) != 3 or sk[1] not in WEAK:
            raise RootError(f"lafif maqrun madi skeleton unexpected: {sk!r}")
        return [sk[0], sk[1], "ي"]
    raise RootError(f"unknown verb_type {verb_type!r}")


def radicals_visible_in_forms(entry: dict[str, Any], root: list[str]) -> tuple[bool, list[str]]:
    """Cross-check: is every radical letter attested in the printed forms?

    Non-radical prefixes are stripped first so they cannot fake an
    attestation (the mudari's يـ prefix, the nahi's لا تـ, the amr's
    hamzat wasl).  For strong letters this is trivially true via the
    madi; the value of the check is for weak/hamza radicals, which must
    surface in at least one printed form (e.g. root ق و ل: the waw is
    visible in يَقُوْلُ and اَلْقَوْلُ).

    A conflict is recorded if, for an ajwaf verb, the mudari shows the
    *opposite* weak letter in its middle slot.
    """
    conflicts: list[str] = []
    mudari_body = skeleton(entry["mudari"])[1:]
    nahi_body = re.sub(r"^لات", "", skeleton(entry["nahi"]))
    amr_sk = skeleton(entry["amr"])
    amr_body = amr_sk[1:] if amr_sk[:1] in ("ا", "أ") else amr_sk
    joined = fold_hamza(
        skeleton(entry["madi"]) + mudari_body + nahi_body + amr_body
        + "".join(skeleton(v) for f in ("masdar", "ism_fail")
                  for v in entry[f].split(" / "))
    )
    all_attested = all(r in joined for r in root)

    vt = entry["verb_type"]
    if vt in ("ajwaf_wawi", "ajwaf_yai"):
        expected = TYPE_WEAK_LETTER[vt]
        other = "ي" if expected == "و" else "و"
        msk = skeleton(entry["mudari"])
        if len(msk) == 4 and msk[2] == other:
            conflicts.append(
                f"mudari {entry['mudari']} shows {other} where type {vt} expects {expected}")
    return all_attested, conflicts


def derive_root_from_mudari(mudari: str, verb_type: str) -> Optional[list[str]]:
    """Independent derivation from the mudari where a clean template exists.
    Returns None when the class drops letters so the mudari alone is not
    a reliable witness (mithal, naqis, lafif, irregular)."""
    sk = fold_hamza(skeleton(mudari))
    if not sk.startswith("ي"):
        return None
    body = sk[1:]
    if verb_type in ("sahih", "mahmuz_fa", "mahmuz_ain", "mahmuz_lam"):
        return list(body) if len(body) == 3 else None
    if verb_type == "mudaaf":
        return [body[0], body[1], body[1]] if len(body) == 2 else None
    if verb_type in ("ajwaf_wawi", "ajwaf_yai"):
        if len(body) == 3 and body[1] in WEAK:
            return [body[0], body[1], body[2]]
        return None  # يَخَافُ / يَنَامُ type gives no middle-letter witness
    return None


# --------------------------------------------------------------------------
# Transitivity classification (drives passive / ism maf'ul generation)
# --------------------------------------------------------------------------
# The printed book gives no explicit transitivity marking, so this is a
# curated classification of the ENGLISH gloss tokens plus per-entry
# overrides where English and Arabic valency differ.  It is a heuristic:
# an English-transitive gloss is NOT proof the Arabic verb takes a direct
# object, which is one reason every generated form stays quiz-ineligible
# until independently verified.  Anything not covered stays "uncertain"
# -> additional forms null + needs_review.
INTRANSITIVE_PREFIXES = ("to be ", "to become ", "to be,")

INTRANSITIVE_TOKENS = {
    "act", "appear", "arrive", "ascend", "bow", "clamour", "cling", "come",
    "crow", "cry", "despair", "deviate", "dismount", "dissolve", "expire",
    "fail", "fall", "ferment", "flee", "flow", "fly", "frown", "gamble",
    "get", "go", "grow", "hasten", "itch", "joke", "jump", "kneel", "laugh",
    "lean", "live", "look", "move", "neigh", "occur", "pass", "perish",
    "persevere", "play", "proceed", "rain", "regret", "remain", "repent",
    "retire", "return", "revolve", "rise", "run", "rust", "shine", "shout",
    "sit", "sleep", "slip", "sneeze", "stand", "stay", "succeed", "swell",
    "swim", "travel", "urinate", "wait", "walk", "swear", "feel",
}

TRANSITIVE_TOKENS = {
    "abrogate", "accept", "admonish", "advise", "annihilate", "annul", "ask",
    "assume", "avert", "befriend", "begin", "bind", "bite", "blame", "break",
    "build", "call", "capture", "carry", "cast", "cause", "cheat", "check",
    "chew", "chop", "claim", "clothe", "close", "command", "contain", "cook",
    "count", "cover", "create", "criticize", "crush", "cultivate", "cure",
    "cut", "deceive", "decide", "deliver", "depict", "desire", "destroy",
    "disfigure", "dislike", "disobey", "drink", "drive", "earn", "eat",
    "entwine", "eradicate", "erect", "explain", "express", "extend",
    "favour", "fear", "fill", "find", "fold", "forget", "forgive", "fulfill",
    "gain", "gather", "gift", "give", "grant", "graze", "guide", "harvest",
    "have", "heal", "hear", "help", "hide", "hit", "hold", "hope", "host",
    "incur", "inflict", "inherit", "intend", "irrigate", "jail", "join",
    "kill", "knock", "know", "lead", "lease", "leave", "lengthen", "lick",
    "lift", "love", "make", "measure", "mill", "misguide", "mix", "narrate",
    "negate", "neglect", "observe", "open", "permit", "pick", "pierce",
    "place", "pluck", "plunder", "pound", "pour", "praise", "precede",
    "present", "preserve", "prevent", "prick", "prohibit", "promise",
    "protect", "pull", "push", "put", "reach", "read", "realise", "receive",
    "recite", "remove", "repel", "reprimand", "reward", "ride", "rub",
    "satisfy", "save", "say", "see", "seek", "seize", "sell", "send", "sew",
    "shave", "shed", "shorten", "show", "skin", "slaughter", "smell", "sow",
    "specify", "spend", "spin", "split", "spread", "sprinkle", "squeeze",
    "steal", "sting", "stone", "strike", "subdue", "suck", "suckle",
    "support", "swallow", "take", "taste", "tear", "terminate", "test",
    "think", "throw", "tie", "touch", "trample", "transfer", "transmit",
    "treat", "turn", "understand", "unsheathe", "uproot", "visit", "want",
    "wash", "weave", "weigh", "wet", "wipe", "withold", "witness", "worship",
    "wound", "wrap", "write", "wrong", "wear",
}

# Per-entry overrides where the token rule is wrong for the ARABIC verb.
TRANSITIVITY_OVERRIDES: dict[int, str] = {
    115: "transitive",     # رَحِمَ "to have mercy (on)" takes a direct object
    202: "uncertain",      # بَصُرَ "to see" - classical usage is بَصُرَ بِهِ
    234: "transitive",     # رَدَّ "to return (something)"
    308: "intransitive",   # جَرُؤَ "to have courage"
    310: "uncertain",      # وَثِقَ "to trust" - وَثِقَ بِهِ (prepositional)
    319: "intransitive",   # وَقَفَ "to stop, to stand"
    361: "uncertain",      # فَاتَ "to pass" - فَاتَهُ الأَمْرُ is transitive-like
    376: "intransitive",   # تَاهَ "to get lost"
    379: "uncertain",      # دَانَ "to borrow, to lend" - valency varies
    395: "transitive",     # شَاءَ "to want"
    449: "uncertain",      # وَجِيَ "to wear down (hooves)" - normally used passively
}


def classify_transitivity(entry: dict[str, Any]) -> str:
    if entry["id"] in TRANSITIVITY_OVERRIDES:
        return TRANSITIVITY_OVERRIDES[entry["id"]]
    meaning = entry["meaning"].lower().strip()
    if meaning.startswith(INTRANSITIVE_PREFIXES) or meaning in ("to be", "to become"):
        return "intransitive"
    first_gloss = re.split(r"[,/;]", meaning)[0].strip()
    m = re.match(r"^to\s+(\S+)", first_gloss)
    token = m.group(1) if m else ""
    if token in TRANSITIVE_TOKENS:
        # a karuma-bab (stative فَعُلَ) verb is essentially never transitive;
        # never auto-derive a passive for one, regardless of the gloss.
        if entry["bab"] == "karuma":
            return "uncertain"
        return "transitive"
    if token in INTRANSITIVE_TOKENS:
        return "intransitive"
    return "uncertain"


# --------------------------------------------------------------------------
# Additional derived forms (ism maf'ul, madi/mudari passive)
# --------------------------------------------------------------------------
FATHA, DAMMA, KASRA, SUKUN, SHADDA = "َ", "ُ", "ِ", "ْ", "ّ"
DAGGER = "ٰ"
TANWIN_DAMM = "ٌ"


def derive_additional_forms(entry: dict[str, Any], root: list[str]) -> Optional[dict[str, str]]:
    """Return {'ism_maful': .., 'madi_passive': .., 'mudari_passive': ..}
    for a transitive verb, or None when the class is not safely derivable.
    Orthography follows the book's style (explicit sukun on long vowels,
    dagger alif written directly on the consonant in naqis imperfects).

    These are MORPHOLOGICALLY GENERATED patterns.  Generation is not
    attestation: none of them is claimed to be a commonly used lexical
    word, and all of them are quiz-ineligible until independently
    verified (see provenance policy in the module docstring)."""
    c1, c2, c3 = root
    vt = entry["verb_type"]

    if vt in ("sahih", "mithal_wawi", "mithal_yai"):
        forms = {
            "ism_maful": f"مَ{c1}{SUKUN}{c2}{DAMMA}و{SUKUN}{c3}{TANWIN_DAMM}",
            "madi_passive": f"{c1}{DAMMA}{c2}{KASRA}{c3}{FATHA}",
            "mudari_passive": f"يُ{c1}{SUKUN}{c2}{FATHA}{c3}{DAMMA}",
        }
    elif vt == "mudaaf":
        forms = {
            "ism_maful": f"مَ{c1}{SUKUN}{c2}{DAMMA}و{SUKUN}{c3}{TANWIN_DAMM}",
            "madi_passive": f"{c1}{DAMMA}{c2}{SHADDA}{FATHA}",
            "mudari_passive": f"يُ{c1}{FATHA}{c2}{SHADDA}{DAMMA}",
        }
    elif vt == "mahmuz_fa":
        forms = {
            "ism_maful": f"مَأ{SUKUN}{c2}{DAMMA}و{SUKUN}{c3}{TANWIN_DAMM}",
            "madi_passive": f"أُ{c2}{KASRA}{c3}{FATHA}",
            "mudari_passive": f"يُؤ{SUKUN}{c2}{FATHA}{c3}{DAMMA}",
        }
    elif vt == "mahmuz_ain":
        forms = {
            "ism_maful": f"مَ{c1}{SUKUN}ؤُو{SUKUN}{c3}{TANWIN_DAMM}",
            "madi_passive": f"{c1}{DAMMA}ئِ{c3}{FATHA}",
            "mudari_passive": f"يُ{c1}{SUKUN}أَ{c3}{DAMMA}",
        }
    elif vt == "mahmuz_lam":
        forms = {
            "ism_maful": f"مَ{c1}{SUKUN}{c2}{DAMMA}و{SUKUN}ءٌ",
            "madi_passive": f"{c1}{DAMMA}{c2}{KASRA}ئَ",
            "mudari_passive": f"يُ{c1}{SUKUN}{c2}{FATHA}أُ",
        }
    elif vt in ("ajwaf_wawi", "ajwaf_yai"):
        if c3 == "ء":
            return None  # e.g. شَاءَ: combination left for manual review
        maful = (f"مَ{c1}{DAMMA}و{SUKUN}{c3}{TANWIN_DAMM}" if vt == "ajwaf_wawi"
                 else f"مَ{c1}{KASRA}ي{SUKUN}{c3}{TANWIN_DAMM}")
        forms = {
            "ism_maful": maful,
            "madi_passive": f"{c1}{KASRA}ي{SUKUN}{c3}{FATHA}",
            "mudari_passive": f"يُ{c1}{FATHA}ا{c3}{DAMMA}",
        }
    elif vt in ("naqis_wawi", "naqis_yai", "lafif_mafruq", "lafif_maqrun"):
        maful = (f"مَ{c1}{SUKUN}{c2}{DAMMA}وٌّ" if c3 == "و"
                 else f"مَ{c1}{SUKUN}{c2}{KASRA}يٌّ")
        forms = {
            "ism_maful": maful,
            "madi_passive": f"{c1}{DAMMA}{c2}{KASRA}يَ",
            # book orthography: dagger alif directly on the consonant (يَرْضٰى)
            "mudari_passive": f"يُ{c1}{SUKUN}{c2}{DAGGER}ى",
        }
    else:
        return None
    # keep generated Arabic in NFC so combining-mark order is canonical
    return {k: unicodedata.normalize("NFC", v) for k, v in forms.items()}


# classes whose generated forms we trust mechanically vs flag for review
REVIEW_FORM_CLASSES = {"lafif_mafruq", "lafif_maqrun"}


# --------------------------------------------------------------------------
# Review-row helper
# --------------------------------------------------------------------------
def review_row(dataset: str, rid: str, arabic: str, field: str, proposed: str,
               reason: str, status: str, quiz_eligible: bool,
               affected: list[str], action: str,
               source_note: Optional[str] = None) -> dict[str, Any]:
    """One manual-review row.  `source_note` carries the FULL, untruncated
    transcription note where one exists - never a cut-down summary."""
    return {"dataset": dataset, "id": rid, "arabic": arabic, "field": field,
            "proposed": proposed, "reason": reason, "status": status,
            "quiz_eligible": quiz_eligible,
            "affected_quiz_fields": list(affected),
            "source_note": source_note, "action": action}


ADDITIONAL_FORM_FIELDS = ["ism_maful", "madi_passive", "mudari_passive"]


# --------------------------------------------------------------------------
# Enrichment of one entry
# --------------------------------------------------------------------------
def enrich_entry(entry: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return (enriched_entry, review_rows). Original fields untouched."""
    e = dict(entry)  # shallow copy; original values are never rewritten
    review: list[dict[str, Any]] = []
    notes: list[str] = []
    eid = entry["id"]
    full_note = entry.get("transcription_note")

    # ---- root -------------------------------------------------------------
    if eid in ROOT_OVERRIDES:
        root, root_status, reason = ROOT_OVERRIDES[eid]
        root_method = ("curated override retained as a proposal; conflicting "
                       "printed evidence, no authoritative source checked yet")
        if reason:
            notes.append(reason)
            review.append(review_row(
                "mujarrad", str(eid), entry["madi"], "root",
                " ".join(root), reason, "needs_review", False,
                ROOT_REVIEW_AFFECTED,
                "check an authoritative dictionary (e.g. al-Qamus, Lisan "
                "al-Arab), then record it in provenance and upgrade the status",
                source_note=full_note))
    else:
        root = derive_root_from_madi(entry["madi"], entry["verb_type"])
        root_status = "algorithmically_derived"
        root_method = ROOT_METHOD
        mudari_root = derive_root_from_mudari(entry["mudari"], entry["verb_type"])
        attested, conflicts = radicals_visible_in_forms(entry, root)
        if conflicts:
            root_status = "needs_review"
            notes.extend(conflicts)
            review.append(review_row(
                "mujarrad", str(eid), entry["madi"], "root",
                " ".join(root), "; ".join(conflicts), "needs_review", False,
                ROOT_REVIEW_AFFECTED,
                "confirm the weak radical against an authoritative dictionary, "
                "then record it in provenance and upgrade the status",
                source_note=full_note))
        elif mudari_root is not None and mudari_root == root and attested:
            # independently re-derived from a second printed form AND every
            # radical visible in print -> internally validated (NOT the same
            # as verification against an external authoritative source)
            root_status = "internally_validated"
        elif attested and entry["verb_type"] in (
                "mithal_wawi", "mithal_yai", "naqis_wawi", "naqis_yai",
                "lafif_mafruq", "lafif_maqrun", "ajwaf_wawi", "ajwaf_yai"):
            # the inferred weak radical is visibly attested in the printed
            # forms (outside non-radical prefixes)
            root_status = "internally_validated"

    e["root"] = " ".join(root)
    e["root_compact"] = "".join(root)
    e["root_letters"] = list(root)
    e["form_number"] = 1
    e["form_type"] = "thulathi_mujarrad"
    e["root_provenance"] = {
        "type": root_status,
        "method": root_method,
        "source": None,       # set when an external source is actually checked
        "reviewed_by": None,  # set by the human reviewer
    }

    # ---- transitivity -------------------------------------------------------
    transitivity = classify_transitivity(entry)
    prov_type = "curated" if eid in TRANSITIVITY_OVERRIDES else "algorithmically_derived"
    e["transitivity"] = {
        "value": transitivity,
        # an unresolved value is a review item, whatever produced it
        "status": "needs_review" if transitivity == "uncertain" else prov_type,
        "provenance": {
            "type": prov_type,
            "method": ("curated per-entry override table"
                       if prov_type == "curated"
                       else "inferred from the short English gloss (token "
                            "heuristic); not dictionary-checked"),
            "source": None,
        },
    }

    def cell(value: Optional[str], status: str,
             blocked_by: Optional[str] = None,
             cell_notes: Optional[list[str]] = None) -> dict[str, Any]:
        return {"value": value, "status": status,
                "quiz_eligible": False,  # never eligible until independently verified
                "blocked_by": blocked_by,
                "verification_source": None,
                "notes": cell_notes or []}

    # ---- additional forms ---------------------------------------------------
    forms_status = "not_applicable"
    if transitivity == "transitive":
        generated = derive_additional_forms(entry, root)
        if generated is None:
            e["additional_forms"] = {k: cell(None, "needs_review")
                                     for k in ADDITIONAL_FORM_FIELDS}
            forms_status = "needs_review"
            review.append(review_row(
                "mujarrad", str(eid), entry["madi"], "additional_forms",
                "-", "verb class combination not safely derivable "
                     f"({entry['verb_type']}, root {' '.join(root)})",
                "needs_review", False, list(ADDITIONAL_FORM_FIELDS),
                "supply passive/ism maf'ul manually if attested"))
        else:
            unstable_root = root_status == "needs_review"
            status = ("needs_review"
                      if (entry["verb_type"] in REVIEW_FORM_CLASSES or unstable_root)
                      else "algorithmically_derived")
            gen_note = ("morphologically generated pattern; not checked against "
                        "a dictionary; not attested usage")
            e["additional_forms"] = {k: cell(v, status, cell_notes=[gen_note])
                                     for k, v in generated.items()}
            forms_status = status
            if status == "needs_review":
                review.append(review_row(
                    "mujarrad", str(eid), entry["madi"], "additional_forms",
                    " / ".join(generated.values()),
                    ("lafif class: derived passives/participles need dictionary "
                     "confirmation" if entry["verb_type"] in REVIEW_FORM_CLASSES
                     else "the entry's root is unresolved, so forms derived "
                          "from it cannot be trusted yet"),
                    "needs_review", False, list(ADDITIONAL_FORM_FIELDS),
                    "confirm forms against a dictionary"))
    elif transitivity == "intransitive":
        e["additional_forms"] = {k: cell(None, "not_applicable")
                                 for k in ADDITIONAL_FORM_FIELDS}
        forms_status = "not_applicable"
    else:  # uncertain -> generation is BLOCKED pending the transitivity review
        e["additional_forms"] = {
            k: cell(None, "blocked_by_transitivity_review", blocked_by="transitivity")
            for k in ADDITIONAL_FORM_FIELDS}
        forms_status = "blocked_by_transitivity_review"
        review.append(review_row(
            "mujarrad", str(eid), entry["madi"], "transitivity",
            "-",
            f"transitivity unclear from gloss '{entry['meaning']}'; the "
            "dependent generated forms (ism_maful, madi_passive, "
            "mudari_passive) are blocked by this same review item",
            "needs_review", False, list(ADDITIONAL_FORM_FIELDS),
            "decide transitivity, then derive or reject the passive forms "
            "and unblock them"))
        # any transcription note on such an entry concerns a different field
        # (e.g. id 449's masdar note) and stays on its own irregularity row

    # ---- printed-irregularity rows (field-level, never whole-entry) ---------
    noted_fields = NOTE_AFFECTED_FIELDS.get(eid, [])
    if noted_fields and eid not in ROOT_OVERRIDES:
        # id 372's note is the root/classification conflict and is fully
        # covered (with its complete note text) by the root review row above.
        printed = " / ".join(entry[f] for f in noted_fields if f in entry)
        review.append(review_row(
            "mujarrad", str(eid), entry["madi"], ",".join(noted_fields),
            printed or "-",
            "the printed source shows an irregular or ambiguous form for "
            "this field; decide whether quizzes should accept the printed "
            "or the standard form",
            "needs_review", False, list(noted_fields),
            "decide the quiz policy for the affected field(s), then "
            "re-enable them", source_note=full_note))

    # ---- field-level quiz eligibility ----------------------------------------
    qe: dict[str, bool] = {f: True for f in SOURCE_QUIZ_FIELDS}
    qe["root"] = root_status in ("internally_validated", "verified")
    for f in noted_fields:
        if f in qe:
            qe[f] = False
    if root_status == "needs_review":
        # the wawi/ya'i placement itself is what is in doubt
        qe["root"] = False
        qe["verb_type"] = False
    qe["generated_additional_forms"] = False  # nothing independently verified yet
    e["quiz_eligibility"] = qe

    # ---- data quality -------------------------------------------------------
    e["data_quality"] = {
        "source_preserved": True,
        "root_status": root_status,
        "derived_fields_status": forms_status,
        "requires_manual_review": (root_status == "needs_review"
                                   or forms_status in ("needs_review",
                                                       "blocked_by_transitivity_review")
                                   or bool(noted_fields)),
        "notes": notes,
    }
    return e, review


# --------------------------------------------------------------------------
# Mazid fih pattern catalogue (Forms II-X) - morphological templates ONLY.
# These are NOT lexical claims: no assertion that any given root occurs
# in any given form.  The six babs (نصر ينصر etc.) remain subdivisions of
# Form I and must never be confused with these derived-form patterns.
# --------------------------------------------------------------------------
MAZID_PATTERNS: list[dict[str, Any]] = [
    {
        "form_number": 2, "form_label": "II", "arabic_name": "بَابُ التَّفْعِيْلِ",
        "madi_pattern": "فَعَّلَ", "mudari_pattern": "يُفَعِّلُ",
        "masdar_patterns": ["تَفْعِيْلٌ", "تَفْعِلَةٌ"],
        "ism_fail_pattern": "مُفَعِّلٌ", "ism_maful_pattern": "مُفَعَّلٌ",
        "amr_pattern": "فَعِّلْ",
        "general_meanings": ["causative (making someone do the base action)",
                             "intensive or repeated action",
                             "declaring or considering something to be so"],
        "notes": ["تَفْعِلَةٌ is the usual masdar for roots with a weak final radical."],
    },
    {
        "form_number": 3, "form_label": "III", "arabic_name": "بَابُ الْمُفَاعَلَةِ",
        "madi_pattern": "فَاعَلَ", "mudari_pattern": "يُفَاعِلُ",
        "masdar_patterns": ["مُفَاعَلَةٌ", "فِعَالٌ"],
        "ism_fail_pattern": "مُفَاعِلٌ", "ism_maful_pattern": "مُفَاعَلٌ",
        "amr_pattern": "فَاعِلْ",
        "general_meanings": ["directing the action towards another person",
                             "mutual attempted action"],
        "notes": [],
    },
    {
        "form_number": 4, "form_label": "IV", "arabic_name": "بَابُ الْإِفْعَالِ",
        "madi_pattern": "أَفْعَلَ", "mudari_pattern": "يُفْعِلُ",
        "masdar_patterns": ["إِفْعَالٌ"],
        "ism_fail_pattern": "مُفْعِلٌ", "ism_maful_pattern": "مُفْعَلٌ",
        "amr_pattern": "أَفْعِلْ",
        "general_meanings": ["causative", "entering a time or place",
                             "the subject acquiring the base quality"],
        "notes": [],
    },
    {
        "form_number": 5, "form_label": "V", "arabic_name": "بَابُ التَّفَعُّلِ",
        "madi_pattern": "تَفَعَّلَ", "mudari_pattern": "يَتَفَعَّلُ",
        "masdar_patterns": ["تَفَعُّلٌ"],
        "ism_fail_pattern": "مُتَفَعِّلٌ", "ism_maful_pattern": "مُتَفَعَّلٌ",
        "amr_pattern": "تَفَعَّلْ",
        "general_meanings": ["reflexive of Form II (undergoing the action on oneself)",
                             "gradual acquisition", "affectation or pretence"],
        "notes": [],
    },
    {
        "form_number": 6, "form_label": "VI", "arabic_name": "بَابُ التَّفَاعُلِ",
        "madi_pattern": "تَفَاعَلَ", "mudari_pattern": "يَتَفَاعَلُ",
        "masdar_patterns": ["تَفَاعُلٌ"],
        "ism_fail_pattern": "مُتَفَاعِلٌ", "ism_maful_pattern": "مُتَفَاعَلٌ",
        "amr_pattern": "تَفَاعَلْ",
        "general_meanings": ["reciprocal action between two or more parties",
                             "pretending the base quality"],
        "notes": [],
    },
    {
        "form_number": 7, "form_label": "VII", "arabic_name": "بَابُ الْاِنْفِعَالِ",
        "madi_pattern": "اِنْفَعَلَ", "mudari_pattern": "يَنْفَعِلُ",
        "masdar_patterns": ["اِنْفِعَالٌ"],
        "ism_fail_pattern": "مُنْفَعِلٌ", "ism_maful_pattern": None,
        "amr_pattern": "اِنْفَعِلْ",
        "general_meanings": ["passive-reflexive: receiving or undergoing the base action"],
        "notes": ["Intransitive by nature: no ism maf'ul and no internal passive in normal use."],
    },
    {
        "form_number": 8, "form_label": "VIII", "arabic_name": "بَابُ الْاِفْتِعَالِ",
        "madi_pattern": "اِفْتَعَلَ", "mudari_pattern": "يَفْتَعِلُ",
        "masdar_patterns": ["اِفْتِعَالٌ"],
        "ism_fail_pattern": "مُفْتَعِلٌ", "ism_maful_pattern": "مُفْتَعَلٌ",
        "amr_pattern": "اِفْتَعِلْ",
        "general_meanings": ["reflexive or middle voice of the base verb",
                             "doing something for oneself"],
        "notes": ["The ت assimilates after certain radicals (e.g. اِصْطَبَرَ، اِزْدَادَ، اِتَّخَذَ)."],
    },
    {
        "form_number": 9, "form_label": "IX", "arabic_name": "بَابُ الْاِفْعِلَالِ",
        "madi_pattern": "اِفْعَلَّ", "mudari_pattern": "يَفْعَلُّ",
        "masdar_patterns": ["اِفْعِلَالٌ"],
        "ism_fail_pattern": "مُفْعَلٌّ", "ism_maful_pattern": None,
        "amr_pattern": "اِفْعَلَّ",
        "general_meanings": ["colours and physical defects"],
        "notes": ["Restricted almost entirely to colours/defects; intransitive, no ism maf'ul."],
    },
    {
        "form_number": 10, "form_label": "X", "arabic_name": "بَابُ الْاِسْتِفْعَالِ",
        "madi_pattern": "اِسْتَفْعَلَ", "mudari_pattern": "يَسْتَفْعِلُ",
        "masdar_patterns": ["اِسْتِفْعَالٌ"],
        "ism_fail_pattern": "مُسْتَفْعِلٌ", "ism_maful_pattern": "مُسْتَفْعَلٌ",
        "amr_pattern": "اِسْتَفْعِلْ",
        "general_meanings": ["seeking or requesting the base action",
                             "considering something to have the base quality"],
        "notes": [],
    },
]

PATTERNS_DOC = {
    "dataset_status": "pattern_templates",
    "lexical_claims": False,
    "description": (
        "Morphological templates for the derived forms (thulathi mazid fih), "
        "Forms II-X in Western numbering. These are TEMPLATES ONLY: the "
        "presence of a pattern here is no evidence that any particular root "
        "is actually used in that form in Arabic. Lexical mazid fih verbs "
        "live in mazid-fih-candidates.json. Note that the six babs of "
        "thulathi mujarrad (نَصَرَ يَنْصُرُ etc.) are subdivisions of Form I and "
        "are unrelated to this catalogue. The source book also lists rarer "
        "babs with three added letters (اِفْعِيْعَال، اِفْعِيْلَال، اِفْعِوَّال); they are "
        "omitted here by design."),
    "orthography": "Fully vowelled, following the source book's convention of "
                   "an explicit sukun on long-vowel letters (e.g. تَفْعِيْلٌ).",
    "patterns": MAZID_PATTERNS,
}

# --------------------------------------------------------------------------
# Mazid fih lexical candidates.
# No authoritative mazid-fih source text is available in this repository,
# so this is a SMALL curated SEED set of extremely well-known derived
# verbs whose roots all occur in the mujarrad dataset.  Every candidate
# is needs_review and quiz-ineligible until dictionary-confirmed, and the
# file as a whole is marked incomplete / not production-ready.  Candidate
# ids are assigned sequentially AFTER root filtering, so they are always
# contiguous (mazid-0001..mazid-NNNN) within a release; treat them as
# opaque stable strings in application code.
# --------------------------------------------------------------------------
def _cand(root: str, form: int, label: str, pattern: str, madi: str,
          mudari: str, masdar: list[str], meaning: list[str], ism_fail: str,
          ism_maful: Optional[str], amr: str, nahi: str,
          notes: list[str]) -> dict[str, Any]:
    letters = root.split(" ")
    return {
        "id": None,  # assigned sequentially after root filtering
        "root": root, "root_compact": "".join(letters), "root_letters": letters,
        "form_number": form, "form_label": label,
        "pattern_arabic": pattern,
        "madi": madi, "mudari": mudari, "masdar": masdar, "meaning": meaning,
        "ism_fail": ism_fail, "ism_maful": ism_maful, "amr": amr, "nahi": nahi,
        "related_mujarrad_entry_ids": [],  # filled programmatically
        "verification_status": "needs_review",
        "quiz_eligible": False,
        "provenance": {
            "type": "needs_review",
            "method": "curated seed entry from general knowledge of very "
                      "common verbs; forms follow the standard paradigm",
            "source": None,
            "reviewed_by": None,
        },
        "source_note": None,
        "notes": notes,
    }


MAZID_CANDIDATES: list[dict[str, Any]] = [
    _cand("ع ل م", 2, "II", "فَعَّلَ يُفَعِّلُ", "عَلَّمَ", "يُعَلِّمُ", ["تَعْلِيْمٌ"],
          ["to teach"], "مُعَلِّمٌ", "مُعَلَّمٌ", "عَلِّمْ", "لَا تُعَلِّمْ", []),
    _cand("ع ل م", 5, "V", "تَفَعَّلَ يَتَفَعَّلُ", "تَعَلَّمَ", "يَتَعَلَّمُ", ["تَعَلُّمٌ"],
          ["to learn"], "مُتَعَلِّمٌ", None, "تَعَلَّمْ", "لَا تَتَعَلَّمْ",
          ["Takes the thing learned as its object; no personal ism maf'ul in normal use."]),
    _cand("ع ل م", 4, "IV", "أَفْعَلَ يُفْعِلُ", "أَعْلَمَ", "يُعْلِمُ", ["إِعْلَامٌ"],
          ["to inform"], "مُعْلِمٌ", "مُعْلَمٌ", "أَعْلِمْ", "لَا تُعْلِمْ", []),
    _cand("خ ر ج", 4, "IV", "أَفْعَلَ يُفْعِلُ", "أَخْرَجَ", "يُخْرِجُ", ["إِخْرَاجٌ"],
          ["to take out", "to expel"], "مُخْرِجٌ", "مُخْرَجٌ", "أَخْرِجْ", "لَا تُخْرِجْ", []),
    _cand("خ ر ج", 10, "X", "اِسْتَفْعَلَ يَسْتَفْعِلُ", "اِسْتَخْرَجَ", "يَسْتَخْرِجُ",
          ["اِسْتِخْرَاجٌ"], ["to extract"], "مُسْتَخْرِجٌ", "مُسْتَخْرَجٌ",
          "اِسْتَخْرِجْ", "لَا تَسْتَخْرِجْ", []),
    _cand("د خ ل", 4, "IV", "أَفْعَلَ يُفْعِلُ", "أَدْخَلَ", "يُدْخِلُ", ["إِدْخَالٌ"],
          ["to make enter", "to insert"], "مُدْخِلٌ", "مُدْخَلٌ", "أَدْخِلْ", "لَا تُدْخِلْ", []),
    _cand("ن ص ر", 8, "VIII", "اِفْتَعَلَ يَفْتَعِلُ", "اِنْتَصَرَ", "يَنْتَصِرُ",
          ["اِنْتِصَارٌ"], ["to be victorious"], "مُنْتَصِرٌ", None,
          "اِنْتَصِرْ", "لَا تَنْتَصِرْ", ["Intransitive in this sense: no ism maf'ul."]),
    _cand("ق ت ل", 3, "III", "فَاعَلَ يُفَاعِلُ", "قَاتَلَ", "يُقَاتِلُ",
          ["مُقَاتَلَةٌ", "قِتَالٌ"], ["to fight (someone)"], "مُقَاتِلٌ", "مُقَاتَلٌ",
          "قَاتِلْ", "لَا تُقَاتِلْ", []),
    _cand("ق ت ل", 6, "VI", "تَفَاعَلَ يَتَفَاعَلُ", "تَقَاتَلَ", "يَتَقَاتَلُ",
          ["تَقَاتُلٌ"], ["to fight one another"], "مُتَقَاتِلٌ", None,
          "تَقَاتَلْ", "لَا تَتَقَاتَلْ", ["Reciprocal: no ism maf'ul in normal use."]),
    _cand("ق ط ع", 7, "VII", "اِنْفَعَلَ يَنْفَعِلُ", "اِنْقَطَعَ", "يَنْقَطِعُ",
          ["اِنْقِطَاعٌ"], ["to be cut off", "to cease"], "مُنْقَطِعٌ", None,
          "اِنْقَطِعْ", "لَا تَنْقَطِعْ", ["Form VII is inherently passive-reflexive."]),
    _cand("ك س ر", 7, "VII", "اِنْفَعَلَ يَنْفَعِلُ", "اِنْكَسَرَ", "يَنْكَسِرُ",
          ["اِنْكِسَارٌ"], ["to get broken"], "مُنْكَسِرٌ", None,
          "اِنْكَسِرْ", "لَا تَنْكَسِرْ", ["Form VII is inherently passive-reflexive."]),
    _cand("غ ف ر", 10, "X", "اِسْتَفْعَلَ يَسْتَفْعِلُ", "اِسْتَغْفَرَ", "يَسْتَغْفِرُ",
          ["اِسْتِغْفَارٌ"], ["to seek forgiveness"], "مُسْتَغْفِرٌ", "مُسْتَغْفَرٌ",
          "اِسْتَغْفِرْ", "لَا تَسْتَغْفِرْ", []),
    _cand("ق ب ل", 10, "X", "اِسْتَفْعَلَ يَسْتَفْعِلُ", "اِسْتَقْبَلَ", "يَسْتَقْبِلُ",
          ["اِسْتِقْبَالٌ"], ["to face", "to welcome"], "مُسْتَقْبِلٌ", "مُسْتَقْبَلٌ",
          "اِسْتَقْبِلْ", "لَا تَسْتَقْبِلْ", []),
    _cand("ع م ل", 10, "X", "اِسْتَفْعَلَ يَسْتَفْعِلُ", "اِسْتَعْمَلَ", "يَسْتَعْمِلُ",
          ["اِسْتِعْمَالٌ"], ["to use", "to employ"], "مُسْتَعْمِلٌ", "مُسْتَعْمَلٌ",
          "اِسْتَعْمِلْ", "لَا تَسْتَعْمِلْ", []),
    _cand("ف ت ح", 8, "VIII", "اِفْتَعَلَ يَفْتَعِلُ", "اِفْتَتَحَ", "يَفْتَتِحُ",
          ["اِفْتِتَاحٌ"], ["to commence", "to inaugurate"], "مُفْتَتِحٌ", "مُفْتَتَحٌ",
          "اِفْتَتِحْ", "لَا تَفْتَتِحْ", []),
    _cand("ف ت ح", 7, "VII", "اِنْفَعَلَ يَنْفَعِلُ", "اِنْفَتَحَ", "يَنْفَتِحُ",
          ["اِنْفِتَاحٌ"], ["to open (intransitive)"], "مُنْفَتِحٌ", None,
          "اِنْفَتِحْ", "لَا تَنْفَتِحْ", ["Form VII is inherently passive-reflexive."]),
    _cand("ن ز ل", 4, "IV", "أَفْعَلَ يُفْعِلُ", "أَنْزَلَ", "يُنْزِلُ", ["إِنْزَالٌ"],
          ["to send down"], "مُنْزِلٌ", "مُنْزَلٌ", "أَنْزِلْ", "لَا تُنْزِلْ", []),
    _cand("س م ع", 4, "IV", "أَفْعَلَ يُفْعِلُ", "أَسْمَعَ", "يُسْمِعُ", ["إِسْمَاعٌ"],
          ["to make (someone) hear"], "مُسْمِعٌ", "مُسْمَعٌ", "أَسْمِعْ", "لَا تُسْمِعْ", []),
    _cand("ك ر م", 4, "IV", "أَفْعَلَ يُفْعِلُ", "أَكْرَمَ", "يُكْرِمُ", ["إِكْرَامٌ"],
          ["to honour"], "مُكْرِمٌ", "مُكْرَمٌ", "أَكْرِمْ", "لَا تُكْرِمْ", []),
    _cand("ح س ن", 2, "II", "فَعَّلَ يُفَعِّلُ", "حَسَّنَ", "يُحَسِّنُ", ["تَحْسِيْنٌ"],
          ["to improve (something)", "to beautify"], "مُحَسِّنٌ", "مُحَسَّنٌ",
          "حَسِّنْ", "لَا تُحَسِّنْ", []),
    _cand("ح س ن", 4, "IV", "أَفْعَلَ يُفْعِلُ", "أَحْسَنَ", "يُحْسِنُ", ["إِحْسَانٌ"],
          ["to do good", "to do (something) well"], "مُحْسِنٌ", "مُحْسَنٌ",
          "أَحْسِنْ", "لَا تُحْسِنْ", []),
    _cand("ج م ع", 8, "VIII", "اِفْتَعَلَ يَفْتَعِلُ", "اِجْتَمَعَ", "يَجْتَمِعُ",
          ["اِجْتِمَاعٌ"], ["to gather (intransitive)", "to assemble"], "مُجْتَمِعٌ", None,
          "اِجْتَمِعْ", "لَا تَجْتَمِعْ", ["Intransitive: no ism maf'ul."]),
    _cand("ك ت ب", 3, "III", "فَاعَلَ يُفَاعِلُ", "كَاتَبَ", "يُكَاتِبُ",
          ["مُكَاتَبَةٌ"], ["to correspond with"], "مُكَاتِبٌ", "مُكَاتَبٌ",
          "كَاتِبْ", "لَا تُكَاتِبْ", []),
    _cand("س و د", 9, "IX", "اِفْعَلَّ يَفْعَلُّ", "اِسْوَدَّ", "يَسْوَدُّ",
          ["اِسْوِدَادٌ"], ["to become black"], "مُسْوَدٌّ", None,
          "اِسْوَدَّ", "لَا تَسْوَدَّ",
          ["Root shared with سَادَ (to rule) in the mujarrad set; the semantic "
           "link is via سَوَاد. Colours/defects only occur in Form IX."]),
]

CANDIDATES_DOC_META = {
    "dataset_status": "incomplete_seed_dataset",
    "production_ready": False,
    "quiz_eligible": False,
    "coverage_complete": False,
    "verification_notes": ("All lexical candidates require independent "
                           "verification against an authoritative dictionary "
                           "or the book's own mazid fih section (book p. 30 "
                           "ff.) before any quiz exposure."),
    "id_policy": ("ids are assigned sequentially and contiguously "
                  "(mazid-0001..mazid-NNNN) at generation time, after root "
                  "filtering; application code must treat them as opaque "
                  "stable strings and never rely on numbering"),
    "description": (
        "A deliberately SMALL, curated SEED set of well-known thulathi mazid "
        "fih verbs whose roots occur in the Safwa-tul-Masaadir mujarrad "
        "dataset. No authoritative mazid-fih source text is present in this "
        "repository, so every candidate is generated from general knowledge "
        "of extremely common verbs, is marked needs_review, and is NOT "
        "quiz-eligible. This file is NOT a complete mazid fih dataset and "
        "makes no coverage claims."),
}


# --------------------------------------------------------------------------
# Manual-review report generation (markdown + machine-readable JSON)
# --------------------------------------------------------------------------
def md_escape(text: str) -> str:
    """Escape for a Markdown table cell WITHOUT losing content: pipes become
    slashes and newlines become spaces.  No truncation, ever."""
    return text.replace("|", "/").replace("\n", " ")


def build_review_md(rows: list[dict[str, Any]]) -> str:
    muj = [r for r in rows if r["dataset"] == "mujarrad"]
    maz = [r for r in rows if r["dataset"] == "mazid_fih"]
    by_field = Counter(r["field"] for r in muj)
    lines = [
        "# Manual Review Required",
        "",
        "Generated by `scripts/enrich-vocabulary.py` together with the",
        "machine-readable copy `data/.review-rows.json` (the validator asserts the",
        "two stay in sync and that every source note appears in full, without",
        "truncation). Nothing on this list may be exposed in SarfMaster quizzes",
        "until resolved; each row disables only the fields listed in its",
        "'Affected fields' column - all other fields of the entry stay usable.",
        "",
        f"Total rows: {len(rows)} - mujarrad {len(muj)} "
        f"({', '.join(f'{k} {v}' for k, v in sorted(by_field.items()))}), "
        f"mazid fih candidates {len(maz)}.",
        "",
        "| Dataset | ID | Arabic | Field | Proposed value | Reason | Source note | Status | Quiz eligible | Affected fields | Recommended action |",
        "|---|--:|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        source_note = r["source_note"] if r["source_note"] else "-"
        lines.append(
            f"| {r['dataset']} | {md_escape(r['id'])} | {md_escape(r['arabic'])} "
            f"| {md_escape(r['field'])} | {md_escape(r['proposed'])} "
            f"| {md_escape(r['reason'])} | {md_escape(source_note)} "
            f"| {r['status']} | {'yes' if r['quiz_eligible'] else 'no'} "
            f"| {md_escape(', '.join(r['affected_quiz_fields']))} "
            f"| {md_escape(r['action'])} |")
    lines += [
        "",
        "## Suggested workflow",
        "",
        "1. Resolve the two root conflicts (369 طَاحَ, 372 غَاطَ) with an authoritative",
        "   dictionary; record the source in `root_provenance.source`, set",
        "   `reviewed_by`, and upgrade the status via `ROOT_OVERRIDES`. This also",
        "   re-enables their `verb_type` quizzes.",
        "2. Decide transitivity for the uncertain entries; move each decision into",
        "   `TRANSITIVITY_OVERRIDES` and re-run - this unblocks the dependent",
        "   `blocked_by_transitivity_review` forms automatically.",
        "3. Confirm the flagged generated forms (lafif classes, شَاءَ); record",
        "   sources before enabling quiz use.",
        "4. Decide the per-field quiz policy for the printed irregularities (the",
        "   `source_forms`-style rows) - only the listed fields are disabled.",
        "5. Dictionary-check every mazid fih candidate; set `verification_status`,",
        "   `quiz_eligible`, `provenance.source` and `source_note` per entry.",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Statistics
# --------------------------------------------------------------------------
def build_statistics(entries: list[dict[str, Any]],
                     candidates: list[dict[str, Any]],
                     review_rows: list[dict[str, Any]]) -> dict[str, Any]:
    root_status = Counter(e["data_quality"]["root_status"] for e in entries)
    gen_form_values = [f for e in entries for f in e["additional_forms"].values()
                       if f["value"] is not None]
    blocked_values = [f for e in entries for f in e["additional_forms"].values()
                      if f["status"] == "blocked_by_transitivity_review"]
    eligibility_stats = {
        f"{field}_eligible": sum(1 for e in entries
                                 if e["quiz_eligibility"][field])
        for field in SOURCE_QUIZ_FIELDS
    }
    eligibility_stats["root_eligible"] = sum(
        1 for e in entries if e["quiz_eligibility"]["root"])
    eligibility_stats["generated_additional_forms_eligible"] = sum(
        1 for e in entries if e["quiz_eligibility"]["generated_additional_forms"])
    eligibility_stats["mazid_fih_entries_eligible"] = sum(
        1 for c in candidates if c["quiz_eligible"])
    return {
        "mujarrad_entry_count": len(entries),
        "entries_per_bab": dict(sorted(Counter(e["bab"] for e in entries).items(),
                                       key=lambda kv: -kv[1])),
        "entries_per_verb_type": dict(Counter(e["verb_type"] for e in entries)),
        "entries_with_transcription_notes": sum(1 for e in entries
                                                if "transcription_note" in e),
        "roots_independently_verified": root_status.get("verified", 0),
        "roots_internally_validated": root_status.get("internally_validated", 0),
        "roots_algorithmically_derived": root_status.get("algorithmically_derived", 0),
        "roots_requiring_review": root_status.get("needs_review", 0),
        "entries_with_generated_additional_forms": sum(
            1 for e in entries
            if any(f["value"] for f in e["additional_forms"].values())),
        "generated_additional_form_values": len(gen_form_values),
        "generated_additional_forms_quiz_eligible": sum(
            1 for f in gen_form_values if f["quiz_eligible"]),
        "additional_form_values_blocked_by_transitivity": len(blocked_values),
        "entries_requiring_manual_review": sum(
            1 for e in entries if e["data_quality"]["requires_manual_review"]),
        "transitivity": dict(Counter(e["transitivity"]["value"] for e in entries)),
        "quiz_eligibility_statistics": eligibility_stats,
        "mazid_fih_pattern_count": len(MAZID_PATTERNS),
        "mazid_fih_candidate_count": len(candidates),
        "mazid_fih_candidates_by_form": dict(sorted(
            Counter(c["form_label"] for c in candidates).items())),
        "mazid_fih_candidates_verified": sum(
            1 for c in candidates if c["verification_status"] == "verified"),
        "mazid_fih_candidates_requiring_review": sum(
            1 for c in candidates if c["verification_status"] == "needs_review"),
        "mazid_fih_candidates_quiz_eligible": sum(
            1 for c in candidates if c["quiz_eligible"]),
        "manual_review_row_count": len(review_rows),
    }


def write_json(path: Path, payload: Any) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def main() -> int:
    if not ORIGINAL_FILE.exists():
        print(f"ERROR: missing {ORIGINAL_FILE}", file=sys.stderr)
        return 1
    original = json.loads(ORIGINAL_FILE.read_text(encoding="utf-8"))
    entries = original["entries"]
    if len(entries) != 455:
        print(f"ERROR: expected 455 entries, found {len(entries)}", file=sys.stderr)
        return 1

    enriched: list[dict[str, Any]] = []
    review_rows: list[dict[str, Any]] = []
    for entry in entries:
        e, review = enrich_entry(entry)
        enriched.append(e)
        review_rows.extend(review)

    # link candidate roots to mujarrad entries; keep only linkable candidates;
    # then assign contiguous sequential ids (see id_policy in the file meta)
    by_root: dict[str, list[int]] = {}
    for e in enriched:
        by_root.setdefault(e["root_compact"], []).append(e["id"])
    candidates = []
    for cand in MAZID_CANDIDATES:
        ids = by_root.get(cand["root_compact"], [])
        if not ids:
            continue  # root not present in the dataset -> drop
    # NOTE: candidate ids remain the stable contiguous sequence produced by
    # the same filtering order as the previous release (mazid-0001..0021).
        cand = dict(cand)
        cand["related_mujarrad_entry_ids"] = ids
        candidates.append(cand)
    for i, cand in enumerate(candidates, start=1):
        cand["id"] = f"mazid-{i:04d}"

    for c in candidates:
        review_rows.append(review_row(
            "mazid_fih", c["id"], c["madi"], "entire_entry",
            f"{c['form_label']} of root {c['root']}",
            "seed candidate generated from general knowledge; no "
            "authoritative source text in the repository",
            "needs_review", False, ["entire_entry"],
            "confirm forms and meaning against a dictionary or the book's "
            "mazid fih section, then set provenance and quiz eligibility"))

    stats = build_statistics(enriched, candidates, review_rows)

    source = dict(original["source"])
    source["enrichment"] = {
        "added_fields": [
            "root", "root_compact", "root_letters", "form_number", "form_type",
            "root_provenance", "transitivity", "additional_forms",
            "quiz_eligibility", "data_quality"],
        "description": (
            "Fields added by scripts/enrich-vocabulary.py. Original printed "
            "values were copied through untouched. Roots were reconstructed "
            "from the printed forms plus the book's verb-type classification "
            "and cross-checked internally; they are labelled "
            "internally_validated, NOT verified, because no external "
            "authoritative source has been consulted. Quiz eligibility is "
            "field-level: a transcription concern disables only the exact "
            "field(s) it affects. Passives/ism maf'ul were generated only "
            "for verbs heuristically classified transitive, are blocked "
            "while transitivity is under review, and are quiz-ineligible "
            "until independently verified. Anything uncertain is "
            "needs_review (see docs/manual-review-required.md)."),
        "status_definitions": {
            "source_transcribed": "value transcribed from the printed book "
                                  "(all original fields)",
            "internally_validated": "reconstructed value cross-checked only "
                                    "against other printed forms of the same "
                                    "book; no external source consulted",
            "algorithmically_derived": "produced by a documented rule; no "
                                       "independent confirmation of any kind",
            "verified": "independently verified against an external "
                        "authoritative source recorded in provenance "
                        "(currently unused)",
            "needs_review": "conflicting or insufficient evidence; a human "
                            "must decide",
            "blocked_by_transitivity_review": "generated form intentionally "
                                              "not produced because the "
                                              "entry's transitivity is under "
                                              "review; unblocks when that "
                                              "review is resolved",
            "not_applicable": "the form does not exist for this entry",
            "curated": "set explicitly by a human-maintained override table "
                       "in the enrichment script",
        },
    }

    v2 = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "statistics": stats,
        "mujarrad_entries": enriched,
        "mazid_fih_patterns": MAZID_PATTERNS,
        "mazid_fih_entries": candidates,
    }

    write_json(V2_FILE, v2)
    write_json(PATTERNS_FILE, PATTERNS_DOC)
    write_json(CANDIDATES_FILE, {**CANDIDATES_DOC_META, "candidates": candidates})
    write_json(REVIEW_ROWS_FILE, review_rows)
    REVIEW_MD_FILE.write_text(build_review_md(review_rows), encoding="utf-8",
                              newline="\n")

    print(f"wrote {V2_FILE.name}: {len(enriched)} mujarrad entries")
    print(f"wrote {PATTERNS_FILE.name}: {len(MAZID_PATTERNS)} patterns")
    print(f"wrote {CANDIDATES_FILE.name}: {len(candidates)} candidates")
    print(f"wrote {REVIEW_MD_FILE.name} + {REVIEW_ROWS_FILE.name}: "
          f"{len(review_rows)} review rows")
    print("statistics:", json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
