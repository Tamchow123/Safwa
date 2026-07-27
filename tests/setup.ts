import "@testing-library/jest-dom/vitest";

import { vi } from "vitest";

// Globally replace Better Auth's `useSession` with a static, timer-free stub.
// Many non-auth components now read the local owner via `useLocalOwner`
// (→ `useSession`, R2-F3); the real hook starts a Better Auth session-refresh
// timer + BroadcastChannel whose nanostore teardown touches `window` AFTER
// jsdom has torn the environment down, surfacing as a flaky post-teardown
// "window is not defined" uncaught exception across the suite. The stub returns
// a signed-out session (the guest default every such test already assumes);
// every other client export stays real, and the auth-specific tests that
// `vi.mock("@/modules/auth/client", …)` themselves still override this entirely.
vi.mock("@/modules/auth/client", async (importActual) => {
  const actual = await importActual<typeof import("@/modules/auth/client")>();
  return {
    ...actual,
    useSession: () => ({ data: null, isPending: false, error: null }),
  };
});
