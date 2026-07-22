/**
 * Phase 16 — canonical event-time derivation (server trust boundary, §13).
 *
 * Pure and deterministic: every clock value (the client instant AND the server
 * receipt instant) is INJECTED, never read from the ambient clock, so the same
 * inputs always yield the same canonical result and the function is fully unit
 * testable. It runs only on the server (the client never derives canonical
 * time), but imports nothing server-only — the timezone maths reuses the shared
 * pure `computeEventTimeFields` helper.
 *
 * Policy (docs/OFFLINE_AND_SYNC.md §5, DATA_MODEL.md §8):
 *  - `occurred_at_canonical` = client instant clamped so that it is
 *      (a) ≤ server-received + ~2 min future tolerance, and
 *      (b) ≥ the same device's previous accepted event on this component chain.
 *    Ceiling (a) takes precedence over floor (b) when they conflict (only
 *    possible under cross-instance server clock skew, which is flagged).
 *  - Missing / unparseable / absurd client time ⇒ fall back to server receipt
 *    and flag `clock_suspect`.
 *  - The local date and UTC offset are recomputed from the authoritative instant
 *    in the submitted IANA zone; an invalid zone falls back to UTC and flags
 *    `timezone_corrected`; client metadata that is internally inconsistent with
 *    its own claimed instant also flags `timezone_corrected`.
 *  - Timestamps NEVER establish causal concurrency — that is lineage's job.
 */
import {
  computeEventTimeFields,
  type EventTimeFields,
  type TimezoneSource,
} from "@/modules/study-engine/attempts";

/** Future tolerance for a client clock running slightly ahead (§13). */
export const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

export type CanonicalTimeInput = {
  /** Client-recorded event instant (ISO-8601). */
  occurredAtClient: string;
  /** Client-recorded IANA timezone name at the event. */
  timezoneAtEvent: string;
  /** Client-claimed UTC offset (minutes) at the event. */
  utcOffsetMinutesAtEvent: number;
  /** Client-claimed local calendar date "YYYY-MM-DD" at the event. */
  localDateAtEvent: string;
  /** Client-declared source of the timezone metadata. */
  timezoneSource: TimezoneSource;
  /** Server receipt instant (epoch ms) — injected, never `Date.now()`. */
  serverReceivedAtMs: number;
  /**
   * Canonical instant (epoch ms) of the same device's previous accepted event
   * on this component chain, or null when this is the chain's first event.
   */
  previousAcceptedCanonicalMs: number | null;
};

export type CanonicalTimeResult = {
  /** Authoritative event instant (ISO-8601). */
  occurredAtCanonical: string;
  /** Authoritative event instant (epoch ms). */
  occurredAtCanonicalMs: number;
  /** The client clock was implausible and was corrected. */
  clockSuspect: boolean;
  /** The timezone metadata was implausible/invalid and was corrected. */
  timezoneCorrected: boolean;
  /** Authoritative fields to persist (recomputed from the canonical instant). */
  timezoneAtEvent: string;
  utcOffsetMinutesAtEvent: number;
  localDateAtEvent: string;
  timezoneSource: TimezoneSource;
};

/** Recompute event-time fields, or null when the IANA zone is invalid. */
function safeEventTimeFields(
  epochMs: number,
  timezone: string,
  timezoneSource: TimezoneSource,
): EventTimeFields | null {
  try {
    return computeEventTimeFields(epochMs, { timezone, timezoneSource });
  } catch (error) {
    // Intl.DateTimeFormat throws RangeError on an unknown IANA zone — absorb
    // ONLY that. Any other error is a real bug and must surface loudly rather
    // than be silently mislabelled as `timezone_corrected`.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * Derive the authoritative event time and correction flags for one ingested
 * event. Never trusts the client's own canonical claims; recomputes everything
 * from the injected clocks and the submitted (validated) metadata.
 */
export function computeCanonicalEventTime(
  input: CanonicalTimeInput,
): CanonicalTimeResult {
  const {
    occurredAtClient,
    timezoneAtEvent,
    utcOffsetMinutesAtEvent,
    localDateAtEvent,
    timezoneSource,
    serverReceivedAtMs,
    previousAcceptedCanonicalMs,
  } = input;

  // The server-receipt instant is server-injected and must be a real clock
  // value; a non-finite value is a caller precondition violation, not
  // untrusted input, and there is no other clock to fall back to — surface it.
  if (!Number.isFinite(serverReceivedAtMs)) {
    throw new Error(
      "computeCanonicalEventTime requires a finite serverReceivedAtMs",
    );
  }
  // A non-finite previous-canonical (e.g. a malformed DB read) is ignored
  // rather than allowed to poison the clamp with NaN.
  const previousMs =
    previousAcceptedCanonicalMs !== null &&
    Number.isFinite(previousAcceptedCanonicalMs)
      ? previousAcceptedCanonicalMs
      : null;

  const futureCeilingMs = serverReceivedAtMs + FUTURE_TOLERANCE_MS;
  const clientMs = Date.parse(occurredAtClient);
  const clientParseable = Number.isFinite(clientMs);

  // --- Step 1: clamp the instant --------------------------------------------
  let clockSuspect = false;
  let canonicalMs: number;
  if (!clientParseable) {
    // Missing/absurd client time ⇒ server receipt + flag.
    canonicalMs = serverReceivedAtMs;
    clockSuspect = true;
  } else if (clientMs > futureCeilingMs) {
    // Beyond the future tolerance ⇒ clamp to server receipt + flag.
    canonicalMs = serverReceivedAtMs;
    clockSuspect = true;
  } else {
    // Within tolerance (including slightly future) ⇒ trust the client instant.
    canonicalMs = clientMs;
  }

  // Never move canonical time backwards before the same device's previous
  // accepted event on this chain (a backwards device clock).
  if (previousMs !== null && canonicalMs < previousMs) {
    canonicalMs = previousMs;
    clockSuspect = true;
  }

  // Precedence: the future-tolerance ceiling is the HARDER invariant. If a
  // skewed previous-canonical (cross-instance server clock skew — an infra
  // anomaly) pushed canonical past the ceiling, cap it back down and flag it.
  // Replay orders serial chains by client_component_revision, not by canonical
  // time, so this best-effort monotonicity relaxation cannot reorder a chain.
  if (canonicalMs > futureCeilingMs) {
    canonicalMs = futureCeilingMs;
    clockSuspect = true;
  }

  // --- Step 2: recompute timezone / local date at the canonical instant -----
  let timezoneCorrected = false;

  // Detect client metadata that is internally inconsistent with its OWN claimed
  // instant+zone (implausible offset, malformed local date, wrong zone) — this
  // is independent of any clamping above.
  if (clientParseable) {
    const clientConsistent = safeEventTimeFields(
      clientMs,
      timezoneAtEvent,
      timezoneSource,
    );
    if (
      clientConsistent === null ||
      clientConsistent.localDateAtEvent !== localDateAtEvent ||
      clientConsistent.utcOffsetMinutesAtEvent !== utcOffsetMinutesAtEvent
    ) {
      timezoneCorrected = true;
    }
  } else {
    timezoneCorrected = true;
  }

  // Authoritative fields come from the canonical instant in the submitted zone;
  // an invalid zone falls back to UTC (server_fallback).
  const canonicalFields = safeEventTimeFields(
    canonicalMs,
    timezoneAtEvent,
    timezoneSource,
  );

  let resultFields: EventTimeFields;
  if (canonicalFields === null) {
    timezoneCorrected = true;
    resultFields = computeEventTimeFields(canonicalMs, {
      timezone: "UTC",
      timezoneSource: "server_fallback",
    });
  } else if (!clockSuspect && !timezoneCorrected) {
    // Fully plausible, unclamped event: preserve the client's submitted local
    // study date verbatim (it equals the recomputed value anyway).
    resultFields = {
      ...canonicalFields,
      localDateAtEvent,
      utcOffsetMinutesAtEvent,
      timezoneAtEvent,
      timezoneSource,
    };
  } else {
    // Clamped or corrected: store the recomputed fields at the canonical instant.
    resultFields = canonicalFields;
  }

  return {
    occurredAtCanonical: new Date(canonicalMs).toISOString(),
    occurredAtCanonicalMs: canonicalMs,
    clockSuspect,
    timezoneCorrected,
    timezoneAtEvent: resultFields.timezoneAtEvent,
    utcOffsetMinutesAtEvent: resultFields.utcOffsetMinutesAtEvent,
    localDateAtEvent: resultFields.localDateAtEvent,
    timezoneSource: resultFields.timezoneSource,
  };
}
