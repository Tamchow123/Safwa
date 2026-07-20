/**
 * Maps thrown `modules/collections/persistence.ts` errors to concise,
 * user-safe copy (Phase 14 §24/§34) — never a raw Dexie message or stack.
 * Shared by every collection-writing dialog/control so the mapping lives in
 * exactly one place.
 */
import {
  DuplicateListNameError,
  InvalidListNameError,
  ListNotFoundError,
  MaxListsExceededError,
  UnknownEntryIdError,
} from "@/modules/collections/persistence";
import { LIST_NAME_MAX_LENGTH } from "@/modules/collections/validation";

const GENERIC_MESSAGE =
  "Couldn't update your saved vocabulary. Please try again.";

export function collectionErrorMessage(error: unknown): string {
  if (error instanceof DuplicateListNameError) {
    return "You already have a list with this name.";
  }
  if (error instanceof InvalidListNameError) {
    return error.reason === "empty"
      ? "Enter a list name."
      : `List names can be at most ${LIST_NAME_MAX_LENGTH} characters.`;
  }
  if (error instanceof MaxListsExceededError) {
    return "You've reached the maximum number of lists.";
  }
  if (
    error instanceof ListNotFoundError ||
    error instanceof UnknownEntryIdError
  ) {
    return GENERIC_MESSAGE;
  }
  return GENERIC_MESSAGE;
}
