import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChangeAgent, type ChangeAgentDO } from "../../src/index.js";

// Runs against the real Artifacts service (see vitest.integration.config.ts) in a
// throwaway repo that's deleted afterwards. Needs `wrangler login` with artifacts:write.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      ARTIFACTS: Artifacts;
      CHANGE_AGENT: DurableObjectNamespace<ChangeAgentDO>;
    }
  }
}

const name = `change-agent-test-${crypto.randomUUID().slice(0, 8)}`;
let agent: ChangeAgent;

beforeAll(async () => {
  agent = await ChangeAgent.init(env.ARTIFACTS, env.CHANGE_AGENT, name);
});

afterAll(async () => {
  await env.ARTIFACTS.delete(name);
});

describe("ChangeAgent on Artifacts", () => {
  it("sets and gets a value", async () => {
    const doc = await agent.set("foo", "bar");
    expect(doc?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await agent.get("foo")).toBe("bar");
  });

  it("skips the commit when the value is unchanged", async () => {
    const before = (await agent.log()).length;
    expect(await agent.set("foo", "bar")).toBeNull();
    expect(await agent.log()).toHaveLength(before);
  });

  it("round-trips nested keys", async () => {
    await agent.set("balter/2014/11/26/puppies.html", "<p>puppies</p>");
    expect(await agent.get("balter/2014/11/26/puppies.html")).toBe("<p>puppies</p>");
  });

  it("lands concurrent writes", async () => {
    const before = (await agent.log()).length;
    await Promise.all([agent.set("a", "1"), agent.set("b", "2")]);
    expect(await agent.get("a")).toBe("1");
    expect(await agent.get("b")).toBe("2");
    expect(await agent.log()).toHaveLength(before + 2);
  });

  it("deletes keys", async () => {
    expect(await agent.delete("foo")).toBe(true);
    expect(await agent.get("foo")).toBeNull();
    expect(await agent.delete("foo")).toBe(false);
  });

  it("writes Ruby-style commit messages", async () => {
    const messages = (await agent.log()).map((c) => c.message);
    expect(messages[0]).toBe("Removing foo");
    expect(messages).toContain("Updating balter/2014/11/26/puppies.html");
  });

  it("hands out a cloneable remote", async () => {
    const remote = await agent.remote();
    expect(remote.url).toMatch(/^https:\/\//);
    expect(remote.token).not.toContain("?expires=");
  });
});
