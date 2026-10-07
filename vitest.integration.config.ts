import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Opt-in: `npm run test:integration`. Talks to the real Artifacts service.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/integration/wrangler.jsonc" },
      remoteBindings: true,
    }),
  ],
  test: { include: ["test/integration/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
