import type { ChangeAgentDO } from "../../src/index.js";
import type { TestChangeAgentDO, TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {
      CHANGE_AGENT: DurableObjectNamespace<TestChangeAgentDO>;
      BARE_AGENT: DurableObjectNamespace<ChangeAgentDO>;
    }
  }
}
