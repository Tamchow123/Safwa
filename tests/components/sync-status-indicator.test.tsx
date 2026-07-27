import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SyncStatus } from "@/modules/sync/client/status";

/**
 * Proves the §20 status indicator: it renders each documented state with honest
 * wording (no raw ids/stack/SQL), stays hidden for guests, offers an accessible
 * manual retry only in the attention state, and exposes a single polite live
 * region for screen-reader announcements. The status derivation itself is
 * unit-tested in status.test.ts; here useSyncStatus is mocked.
 */
let currentStatus: SyncStatus | null;
const retryMock = vi.fn();
vi.mock("@/components/sync/sync-provider", () => ({
  useOptionalSyncStatus: () =>
    currentStatus === null ? null : { status: currentStatus, retry: retryMock },
}));

import { SyncStatusIndicator } from "@/components/sync/sync-status-indicator";

beforeEach(() => {
  retryMock.mockClear();
  currentStatus = { kind: "synced", pendingCount: 0 };
});

describe("SyncStatusIndicator", () => {
  it("renders nothing outside a SyncProvider (isolated header render)", () => {
    currentStatus = null;
    const { container } = render(<SyncStatusIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a guest", () => {
    currentStatus = { kind: "guest", pendingCount: 0 };
    const { container } = render(<SyncStatusIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the synced state via a polite live region", () => {
    currentStatus = { kind: "synced", pendingCount: 0 };
    render(<SyncStatusIndicator />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/synced/i);
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("shows a spinner and honest text while syncing", () => {
    currentStatus = { kind: "syncing", pendingCount: 0 };
    render(<SyncStatusIndicator />);
    expect(screen.getByText("Syncing")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/syncing/i);
  });

  it("pluralises the pending count", () => {
    currentStatus = { kind: "pending", pendingCount: 1 };
    const { rerender } = render(<SyncStatusIndicator />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 change waiting to sync",
    );
    expect(screen.getByText("1 pending")).toBeInTheDocument();

    currentStatus = { kind: "pending", pendingCount: 4 };
    rerender(<SyncStatusIndicator />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "4 changes waiting to sync",
    );
    expect(screen.getByText("4 pending")).toBeInTheDocument();
  });

  it("shows an honest offline message", () => {
    currentStatus = { kind: "offline", pendingCount: 2 };
    render(<SyncStatusIndicator />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/reconnect/i);
  });

  it("shows the disabled state without alarming wording", () => {
    currentStatus = { kind: "disabled", pendingCount: 0 };
    render(<SyncStatusIndicator />);
    expect(screen.getByText("Sync off")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i);
  });

  describe("attention state", () => {
    beforeEach(() => {
      currentStatus = { kind: "attention", pendingCount: 3 };
    });

    it("exposes a keyboard-accessible detail with a manual retry", async () => {
      const user = userEvent.setup();
      render(<SyncStatusIndicator />);

      expect(screen.getByRole("status")).toHaveTextContent(/attention/i);
      // The trigger is a real button, focusable and openable by keyboard.
      const trigger = screen.getByRole("button", { name: /attention/i });
      trigger.focus();
      await user.keyboard("{Enter}");

      // Honest detail — no raw ids / stack / SQL.
      expect(
        await screen.findByText(/hasn’t reached the server yet/i),
      ).toBeInTheDocument();
      const retry = screen.getByRole("menuitem", { name: /retry sync/i });
      await user.click(retry);
      expect(retryMock).toHaveBeenCalledTimes(1);
    });

    it("does not leak raw ids/errors in its detail copy", async () => {
      const user = userEvent.setup();
      render(<SyncStatusIndicator />);
      await user.click(screen.getByRole("button", { name: /attention/i }));
      const detail = await screen.findByText(/hasn’t reached the server/i);
      // No id-like tokens, SQL keywords, or stack frames.
      expect(detail.textContent ?? "").not.toMatch(
        /\b(select|insert|update|error:|at\s+\w+\.|user-[0-9a-f]{4})\b/i,
      );
    });
  });

  it("keeps the live region stable across a transition so it announces in place", () => {
    currentStatus = { kind: "syncing", pendingCount: 0 };
    const { rerender } = render(<SyncStatusIndicator />);
    expect(screen.getByRole("status")).toHaveTextContent(/syncing/i);

    currentStatus = { kind: "synced", pendingCount: 0 };
    rerender(<SyncStatusIndicator />);
    // Same single live region, updated text (announced once, no duplicate regions).
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveTextContent(/synced/i);
  });
});
