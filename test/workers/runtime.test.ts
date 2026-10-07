import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { createMemoryFs } from "../../src/fs.js";

// Checks that the Git stack and the Durable Object run in workerd at all.
// artifacts.test.ts covers behavior end to end.
describe("in workerd", () => {
  it("commits to an in-memory repo with isomorphic-git and memfs", async () => {
    const fs = createMemoryFs();
    await git.init({ fs, dir: "/repo", defaultBranch: "main" });
    await fs.promises.mkdir("/repo/a/b", { recursive: true });
    await fs.promises.writeFile("/repo/a/b/c.txt", new TextEncoder().encode("hello"));
    await git.add({ fs, dir: "/repo", filepath: "a/b/c.txt" });
    const oid = await git.commit({
      fs,
      dir: "/repo",
      message: "Updating a/b/c.txt",
      author: { name: "Change Agent", email: "change-agent@users.noreply.github.com" },
    });
    const { blob } = await git.readBlob({ fs, dir: "/repo", oid, filepath: "a/b/c.txt" });
    expect(new TextDecoder().decode(blob)).toBe("hello");
  });

  it("runs ChangeAgentDO and explains a missing Artifacts binding", async () => {
    const stub = env.BARE_AGENT.get(env.BARE_AGENT.idFromName("repo"));
    const target = { repo: "repo", branch: "main", author: { name: "a", email: "b@example.com" } };
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.set(target, "foo", "bar")).rejects.toThrow(/Artifacts binding named ARTIFACTS/);
    });
  });
});
