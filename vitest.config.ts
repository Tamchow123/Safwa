import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/**/*.test.{ts,tsx}",
      "modules/**/*.test.{ts,tsx}",
      "shared/**/*.test.{ts,tsx}",
      "lib/**/*.test.{ts,tsx}",
    ],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
    },
  },
});
