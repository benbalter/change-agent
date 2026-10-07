import { ChangeAgentDO } from "../../src/index.js";
import { FakeArtifacts } from "./fake-artifacts.js";

export interface TestEnv {
  /** Real Artifacts, in live mode (wrangler.live.jsonc). */
  ARTIFACTS?: Artifacts;
  /** The local stand-in from test/support/git-server.ts, otherwise. */
  GIT_SERVER_URL?: string;
}

export function artifactsFor(env: TestEnv): Artifacts {
  if (env.ARTIFACTS) return env.ARTIFACTS;
  if (!env.GIT_SERVER_URL) throw new Error("Set ARTIFACTS or GIT_SERVER_URL");
  return new FakeArtifacts(env.GIT_SERVER_URL) as unknown as Artifacts;
}

/** ChangeAgentDO pointed at whichever Artifacts the tests are using. */
export class TestChangeAgentDO extends ChangeAgentDO<TestEnv> {
  protected override artifacts(): Artifacts {
    return artifactsFor(this.env);
  }
}

// The class as a consumer would bind it, for the runtime smoke test.
export { ChangeAgentDO };

export default {
  async fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
