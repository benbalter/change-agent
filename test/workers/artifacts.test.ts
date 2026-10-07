import { env } from "cloudflare:workers";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChangeAgent } from "../../src/index.js";
import { createMemoryFs } from "../../src/fs.js";
import { artifactsFor } from "./worker.js";

// End to end: client -> Durable Object -> isomorphic-git push -> reads through the
// binding. Runs against the local stand-in by default, or real Artifacts with
// `npm run test:live`. Same tests either way, so the fake is checked against the
// real service whenever the live run happens.
const live = Boolean(env.ARTIFACTS);
const artifacts = artifactsFor(env);
const prefix = `change-agent-test-${crypto.randomUUID().slice(0, 8)}`;
const created: string[] = [];

async function open(suffix: string, options = {}) {
  const name = `${prefix}-${suffix}`;
  created.push(name);
  return ChangeAgent.init(artifacts, env.CHANGE_AGENT, name, options);
}

let agent: ChangeAgent;

beforeAll(async () => {
  agent = await open("main");
});

afterAll(async () => {
  await Promise.all(created.map((name) => artifacts.delete(name)));
});

describe(`ChangeAgent on ${live ? "live" : "local stand-in"} Artifacts`, () => {
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

  it("round-trips nested keys and binary values", async () => {
    await agent.set("balter/2014/11/26/puppies.html", "<p>puppies</p>");
    expect(await agent.get("balter/2014/11/26/puppies.html")).toBe("<p>puppies</p>");
    const bytes = new Uint8Array([0, 255, 1, 254]);
    await agent.set("blob.bin", bytes);
    expect((await agent.getDocument("blob.bin"))?.bytes).toEqual(bytes);
  });

  it("lands concurrent writes", async () => {
    const before = (await agent.log()).length;
    await Promise.all([agent.set("a", "1"), agent.set("b", "2"), agent.set("c", "3")]);
    expect([await agent.get("a"), await agent.get("b"), await agent.get("c")]).toEqual(["1", "2", "3"]);
    expect(await agent.log()).toHaveLength(before + 3);
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

  it("picks up commits pushed by other Git clients", async () => {
    // Push a commit the Durable Object didn't make, with a plain Git client.
    const { url, token } = await agent.remote({ scope: "write" });
    const fs = createMemoryFs();
    const onAuth = () => ({ username: "x", password: token });
    await git.clone({ fs, http, dir: "/w", url, ref: agent.branch, singleBranch: true, depth: 1, onAuth });
    await fs.promises.writeFile("/w/a", new TextEncoder().encode("from elsewhere"));
    await git.add({ fs, dir: "/w", filepath: "a" });
    await git.commit({
      fs,
      dir: "/w",
      message: "Outside edit",
      author: { name: "t", email: "t@example.com" },
    });
    await git.push({ fs, http, dir: "/w", url, ref: agent.branch, onAuth });

    // The DO's cached clone is now stale. Setting a back to its old value must
    // commit, not be skipped as unchanged.
    expect(await agent.set("a", "1")).not.toBeNull();
    expect(await agent.get("a")).toBe("1");
    expect((await agent.log({ limit: 2 })).map((c) => c.message)).toEqual(["Updating a", "Outside edit"]);
  });

  it("refuses pushes with a read-only token", async () => {
    const { url, token } = await agent.remote();
    const fs = createMemoryFs();
    const onAuth = () => ({ username: "x", password: token });
    await git.clone({ fs, http, dir: "/r", url, ref: agent.branch, singleBranch: true, depth: 1, onAuth });
    await fs.promises.writeFile("/r/nope", new TextEncoder().encode("x"));
    await git.add({ fs, dir: "/r", filepath: "nope" });
    await git.commit({ fs, dir: "/r", message: "Nope", author: { name: "t", email: "t@example.com" } });
    await expect(git.push({ fs, http, dir: "/r", url, ref: agent.branch, onAuth })).rejects.toThrow();
  });

  it("imports an existing repo onto its own default branch", async () => {
    // Live: the Ruby gem's demo data (default branch master). Local: a repo on the stand-in.
    let url = "https://github.com/benbalter/change_agent_demo";
    if (!live) {
      const source = await open("source", { branch: "master" });
      await source.set("foo", "bar");
      url = (await source.remote()).url;
    }
    const name = `${prefix}-imported`;
    created.push(name);
    const imported = await ChangeAgent.import(artifacts, env.CHANGE_AGENT, name, { url });
    expect(imported.branch).toBe("master");
    expect((await imported.log()).length).toBeGreaterThan(0);
    const doc = await imported.set("change-agent-test", "written after import");
    expect(doc).not.toBeNull();
    expect((await imported.log({ limit: 1 }))[0]?.parents).toHaveLength(1);
  });
});
