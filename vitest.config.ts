import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { startGitServer } from "./test/support/git-server.js";

// Tests that run inside workerd. By default, Artifacts is replaced by a local
// stand-in (test/support/git-server.ts). CHANGE_AGENT_LIVE=1 uses real Artifacts
// instead, which needs a Workers Paid account with Artifacts access.
// Node-only tests live in test/node (vitest.node.config.ts).
export default defineConfig(async () => {
  const live = Boolean(process.env.CHANGE_AGENT_LIVE);
  const server = live ? null : await startGitServer();
  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: live ? "./test/workers/wrangler.live.jsonc" : "./test/workers/wrangler.jsonc",
        },
        remoteBindings: live,
        miniflare: server ? { bindings: { GIT_SERVER_URL: server.url } } : {},
      }),
    ],
    test: {
      include: live ? ["test/workers/artifacts.test.ts"] : ["test/workers/**/*.test.ts"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  };
});
