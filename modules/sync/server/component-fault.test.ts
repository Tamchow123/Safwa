/**
 * REL-006 — the component-isolation failure classifier and the contract that
 * gives it its point: the structural code must NOT be recoverable.
 */
import { describe, expect, it } from "vitest";

import { ChainError } from "@/modules/scheduler";
import { isRecoverableReason } from "@/modules/sync/protocol";

import { componentFaultReason } from "./component-fault";

describe("componentFaultReason", () => {
  it("names a ChainError as the permanent structural condition", () => {
    expect(componentFaultReason(new ChainError("cycle detected"))).toBe(
      "component_integrity_error",
    );
  });

  it("leaves every other failure as the retryable internal_error", () => {
    // A dropped connection, a lock timeout or an ordinary bug IS worth
    // retrying — collapsing both cases into one code is what this split exists
    // to undo, so widening it back would be just as wrong as the original.
    expect(componentFaultReason(new Error("connection terminated"))).toBe(
      "internal_error",
    );
    expect(componentFaultReason("not an error at all")).toBe("internal_error");
    expect(componentFaultReason(undefined)).toBe("internal_error");
  });

  it("recognises a ChainError thrown from a subclass or rethrow path", () => {
    class WrappedChainError extends ChainError {}
    expect(componentFaultReason(new WrappedChainError("nested"))).toBe(
      "component_integrity_error",
    );
  });
});

describe("the structural reason code is not recoverable", () => {
  it("keeps component_integrity_error out of the retryable set", () => {
    // The whole reason for a separate code: `internal_error` is recoverable, so
    // reporting stored corruption as one had every client retrying a condition
    // no resubmission can repair.
    expect(isRecoverableReason("component_integrity_error")).toBe(false);
    expect(isRecoverableReason("internal_error")).toBe(true);
  });
});
