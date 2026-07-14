import { describe, expect, it } from "vitest";

import {
  parseAnswerReference,
  serializeAnswerReference,
} from "@/modules/content/answer-reference";
import { ANSWER_FIELDS } from "@/modules/content/constants";

describe("stable answer references", () => {
  it("round-trips every allowed field", () => {
    for (const field of ANSWER_FIELDS) {
      const reference = { entryId: 42, field };
      const serialized = serializeAnswerReference(reference);
      expect(serialized).toBe(`entry:42:field:${field}`);
      expect(parseAnswerReference(serialized)).toEqual(reference);
    }
  });

  it("rejects invalid strings", () => {
    for (const bad of [
      "",
      "entry:42",
      "entry:0:field:madi", // ids start at 1
      "entry:-3:field:madi",
      "entry:42:field:passive", // not an allowed field
      "entry:42:field:MADI",
      "entry:1.5:field:madi",
      "entry:42:field:madi:extra",
      "field:madi:entry:42",
    ]) {
      expect(() => parseAnswerReference(bad), bad).toThrow();
    }
  });

  it("rejects invalid reference objects on serialization", () => {
    expect(() =>
      serializeAnswerReference({
        entryId: 42,
        // @ts-expect-error — invalid field must be rejected at runtime too
        field: "passive",
      }),
    ).toThrow();
    expect(() =>
      serializeAnswerReference({ entryId: 0, field: "madi" }),
    ).toThrow();
  });

  it("does not embed answer values", () => {
    const serialized = serializeAnswerReference({ entryId: 7, field: "madi" });
    expect(serialized.split(":")).toHaveLength(4);
  });
});
