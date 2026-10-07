import { defineConfig } from "vitest/config";

// Write-path tests run in Node against a real Git server (see test/node/store.test.ts).
export default defineConfig({
  test: { include: ["test/node/**/*.test.ts"], testTimeout: 30_000 },
});
