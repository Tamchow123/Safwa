import { StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Typed so the departing-account argument can be asserted: the point of this
 * component is which account it names, and that it names one at all rather
 * than falling back to the every-account sweep.
 */
const clearAccountLocalState = vi.hoisted(() =>
  vi.fn<(db: unknown, departing: string | null) => Promise<void>>(async () =>
    Promise.resolve(),
  ),
);
vi.mock("@/modules/sync/client/logout", () => ({ clearAccountLocalState }));
vi.mock("@/modules/content/db", () => ({ getSafwaDb: () => ({}) }));

const replace = vi.hoisted(() => vi.fn());
const params = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => params.current,
  useRouter: () => ({ replace }),
  usePathname: () => "/",
}));

import {
  ACCOUNT_DELETED_PARAM,
  DeletedAccountCleanup,
  deletedAccountCallback,
} from "@/components/account/deleted-account-cleanup";
import {
  forgetPendingAccountDeletion,
  readPendingAccountDeletion,
  rememberPendingAccountDeletion,
} from "@/components/account/pending-account-deletion";

const NONCE = "9d3a1f2c-0000-4000-8000-abcabcabcabc";

/** Land on the callback URL as Better Auth would return the browser to it. */
function arriveWith(nonce: string) {
  params.current = new URLSearchParams(`${ACCOUNT_DELETED_PARAM}=${nonce}`);
}

/** A deletion this device requested and can therefore vouch for. */
function requestDeletionOf(userId: string, nonce = NONCE) {
  rememberPendingAccountDeletion(userId, nonce, Date.now());
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  params.current = new URLSearchParams();
});

describe("clearing a deleted account's local rows (§11)", () => {
  it("does nothing on an ordinary page load", async () => {
    // The sweep must fire ONLY where a deletion really happened. Reconciling on
    // every load would mean guessing from a session that had merely failed to
    // resolve, and the penalty for guessing is deleting synced history.
    requestDeletionOf("user-1");
    render(<DeletedAccountCleanup />);
    await waitFor(() => expect(replace).not.toHaveBeenCalled());
    expect(clearAccountLocalState).not.toHaveBeenCalled();
  });

  it("clears exactly the account this device asked to delete", async () => {
    requestDeletionOf("user-1");
    arriveWith(NONCE);
    render(<DeletedAccountCleanup />);
    await waitFor(() =>
      expect(clearAccountLocalState).toHaveBeenCalledTimes(1),
    );
    // Named, not `null`: the unknown-account sweep would take a SECOND
    // account's rows off a shared device along with the deleted one's.
    expect(clearAccountLocalState.mock.calls[0]?.[1]).toBe("user-1");
  });

  it("spends the nonce so the same link cannot replay the cleanup", async () => {
    requestDeletionOf("user-1");
    arriveWith(NONCE);
    render(<DeletedAccountCleanup />);
    await waitFor(() =>
      expect(readPendingAccountDeletion(NONCE, Date.now())).toBeNull(),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("builds the callback URL the reader looks at", async () => {
    // The dialog and this component have to agree, and they are in different
    // files — so the URL is built by one exported function, not two spellings.
    const url = deletedAccountCallback(NONCE);
    expect(
      new URLSearchParams(url.slice(url.indexOf("?"))).get(
        ACCOUNT_DELETED_PARAM,
      ),
    ).toBe(NONCE);
  });

  it("round-trips a nonce that needs URL encoding", async () => {
    const awkward = "a b&c=d/e";
    const url = deletedAccountCallback(awkward);
    expect(
      new URLSearchParams(url.slice(url.indexOf("?"))).get(
        ACCOUNT_DELETED_PARAM,
      ),
    ).toBe(awkward);
  });
});

describe("the marker alone is not authority to delete anything", () => {
  it("ignores a link when this device never requested a deletion", async () => {
    // THE attack this design exists to stop: a link with the parameter
    // appended, sent to a learner whose account is alive. Without a matching
    // record it must do nothing at all — the account's queued-but-unpushed
    // mutations exist nowhere else.
    forgetPendingAccountDeletion();
    arriveWith("attacker-supplied");
    render(<DeletedAccountCleanup />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(clearAccountLocalState).not.toHaveBeenCalled();
  });

  it("ignores a link whose nonce does not match, and keeps the request alive", async () => {
    // The case the earlier "nobody is signed in" gate got wrong: a learner who
    // requested a deletion and has not confirmed it is not fair game. A guessed
    // or stale value neither wipes their data nor cancels their request.
    requestDeletionOf("user-1");
    arriveWith("not-the-right-nonce");
    render(<DeletedAccountCleanup />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(clearAccountLocalState).not.toHaveBeenCalled();
    expect(readPendingAccountDeletion(NONCE, Date.now())).toBe("user-1");
  });

  it("ignores a request older than the deletion token that carried it", async () => {
    // A learner who asked to delete, changed their mind and never followed the
    // link should not stay one leaked nonce away from losing their data.
    rememberPendingAccountDeletion(
      "user-1",
      NONCE,
      Date.now() - 25 * 60 * 60 * 1000,
    );
    arriveWith(NONCE);
    render(<DeletedAccountCleanup />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(clearAccountLocalState).not.toHaveBeenCalled();
  });
});

describe("one sweep, finalised, however React mounts it", () => {
  it("sweeps once and still spends the nonce under StrictMode", async () => {
    // StrictMode mounts, cleans up and remounts. The run that does the work is
    // therefore the one whose own cleanup has already fired — so gating the
    // finalisation on a per-run `cancelled` flag would skip spending the nonce
    // after a sweep that genuinely succeeded, leaving the URL looking like a
    // failure. Nothing may be swept twice either.
    requestDeletionOf("user-1");
    arriveWith(NONCE);
    render(
      <StrictMode>
        <DeletedAccountCleanup />
      </StrictMode>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(clearAccountLocalState).toHaveBeenCalledTimes(1);
    expect(readPendingAccountDeletion(NONCE, Date.now())).toBeNull();
  });

  it("finalises even if the component unmounts mid-sweep", async () => {
    // A learner navigating away an instant after landing must not be left with
    // a spent-but-unforgotten record and a nonce still in the URL.
    let finish: () => void = () => {};
    clearAccountLocalState.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    requestDeletionOf("user-1");
    arriveWith(NONCE);
    const view = render(<DeletedAccountCleanup />);
    await waitFor(() =>
      expect(clearAccountLocalState).toHaveBeenCalledTimes(1),
    );

    view.unmount();
    finish();

    await waitFor(() =>
      expect(readPendingAccountDeletion(NONCE, Date.now())).toBeNull(),
    );
  });
});

describe("a failed sweep stays retryable", () => {
  it("keeps the nonce in the URL and the record on disk", async () => {
    // Dropping the marker on failure is what the previous round did, and it
    // silently forecloses the only retry path: the URL is the sole thing that
    // brings this component back, so one transient IndexedDB error would leave
    // a deleted account's rows on the device permanently.
    clearAccountLocalState.mockRejectedValueOnce(new Error("indexeddb gone"));
    requestDeletionOf("user-1");
    arriveWith(NONCE);
    render(<DeletedAccountCleanup />);

    await waitFor(() =>
      expect(clearAccountLocalState).toHaveBeenCalledTimes(1),
    );
    expect(replace).not.toHaveBeenCalled();
    expect(readPendingAccountDeletion(NONCE, Date.now())).toBe("user-1");
  });

  it("succeeds on the retry a reload gives it", async () => {
    clearAccountLocalState.mockRejectedValueOnce(new Error("indexeddb gone"));
    requestDeletionOf("user-1");
    arriveWith(NONCE);
    const first = render(<DeletedAccountCleanup />);
    await waitFor(() =>
      expect(clearAccountLocalState).toHaveBeenCalledTimes(1),
    );
    first.unmount();

    render(<DeletedAccountCleanup />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(readPendingAccountDeletion(NONCE, Date.now())).toBeNull();
  });
});
