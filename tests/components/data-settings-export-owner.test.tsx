/**
 * Export-my-data owner resolution (ARCH-005).
 *
 * An export is a ONE-SHOT artifact, not a self-correcting live view: if the
 * owner reads as a guest during the auth-session pending window, the downloaded
 * file permanently omits the signed-in account's own data while the success
 * toast reports nothing wrong. The action must therefore resolve its owner at
 * ACTION time (`useResolveOwner`), not from the read-only `useLocalOwner`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useSessionMock = vi.fn();
const getSessionMock = vi.fn();
const buildExportPayloadMock = vi.fn();
const triggerJsonDownloadMock = vi.fn();

vi.mock("@/modules/auth/client", () => ({
  authClient: { getSession: () => getSessionMock() },
  useSession: () => useSessionMock(),
}));

vi.mock("@/modules/content/db", () => ({
  getSafwaDb: () => ({}) as unknown,
}));

vi.mock("@/modules/profile/export", () => ({
  buildExportPayload: (...args: unknown[]) => buildExportPayloadMock(...args),
  serializeExport: () => "{}",
  exportFilename: () => "safwa-export-2026-07-27.json",
  triggerJsonDownload: (...args: unknown[]) => triggerJsonDownloadMock(...args),
}));

vi.mock("sonner", () => ({ toast: vi.fn() }));

const { DataSettings } = await import("@/components/settings/data-settings");

beforeEach(() => {
  vi.clearAllMocks();
  buildExportPayloadMock.mockResolvedValue({});
});

describe("DataSettings export owner (ARCH-005)", () => {
  it("exports as the ACCOUNT when the session is still pending at click time", async () => {
    // The hook reports pending (indistinguishable from signed-out); only the
    // action-time resolution reveals the real signed-in identity.
    useSessionMock.mockReturnValue({ data: undefined, isPending: true });
    getSessionMock.mockResolvedValue({ data: { user: { id: "acct-1" } } });

    render(<DataSettings />);
    await userEvent.click(screen.getByRole("button", { name: /export/i }));

    await waitFor(() => expect(buildExportPayloadMock).toHaveBeenCalled());
    // Third argument is the owner: it must be the account, never null.
    expect(buildExportPayloadMock.mock.calls[0]?.[2]).toBe("acct-1");
    expect(triggerJsonDownloadMock).toHaveBeenCalled();
  });

  it("exports as the account once the session has resolved, without a refetch", async () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: "acct-1" } },
      isPending: false,
    });

    render(<DataSettings />);
    await userEvent.click(screen.getByRole("button", { name: /export/i }));

    await waitFor(() => expect(buildExportPayloadMock).toHaveBeenCalled());
    expect(buildExportPayloadMock.mock.calls[0]?.[2]).toBe("acct-1");
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("exports as the GUEST for a genuinely signed-out visitor", async () => {
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    render(<DataSettings />);
    await userEvent.click(screen.getByRole("button", { name: /export/i }));

    await waitFor(() => expect(buildExportPayloadMock).toHaveBeenCalled());
    expect(buildExportPayloadMock.mock.calls[0]?.[2]).toBeNull();
  });
});
