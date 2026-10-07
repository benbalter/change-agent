// The smallest Worker a consumer would write: re-export the Durable Object.
export { ChangeAgentDO } from "../../src/index.js";

export default {
  async fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
