import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Runtime smoke tests inside workerd. Behavior tests live in test/node (vitest.node.config.ts).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workers/wrangler.jsonc" } })],
  test: { include: ["test/workers/**/*.test.ts"] },
});
