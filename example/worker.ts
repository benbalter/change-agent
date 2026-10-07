import { ChangeAgent } from "change-agent";

// Re-export the Durable Object so Wrangler can bind it.
export { ChangeAgentDO } from "change-agent";

interface Env {
  ARTIFACTS: Artifacts;
  CHANGE_AGENT: DurableObjectNamespace<import("change-agent").ChangeAgentDO>;
}

// Pages to track. Each one is stored at <host>/<path>, so the repo reads like the site.
const PAGES = ["https://www.whitehouse.gov/briefing-room/", "https://www.congress.gov/"];

export default {
  // Every hour, fetch each page and commit it if it changed.
  async scheduled(_controller, env) {
    const agent = await ChangeAgent.init(env.ARTIFACTS, env.CHANGE_AGENT, "press-releases");
    for (const page of PAGES) {
      const url = new URL(page);
      const key = `${url.host}${url.pathname.replace(/\/$/, "/index")}.html`;
      const doc = await agent.set(key, await (await fetch(url)).text());
      console.log(doc ? `${key} changed in ${doc.commit}` : `${key} unchanged`);
    }
  },

  // GET /<key> returns the latest stored copy.
  async fetch(request, env) {
    const agent = new ChangeAgent(env.ARTIFACTS, env.CHANGE_AGENT, "press-releases");
    const value = await agent.get(new URL(request.url).pathname.slice(1));
    return value === null ? new Response("Not found", { status: 404 }) : new Response(value);
  },
} satisfies ExportedHandler<Env>;
