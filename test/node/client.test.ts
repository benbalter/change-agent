import { describe, expect, it, vi } from "vitest";
import { tokenSecret } from "../../src/artifacts.js";
import { ChangeAgent, type WriterNamespace } from "../../src/client.js";
import type { WriteTarget } from "../../src/durable-object.js";
import { InvalidKeyError, RepoNotReadyError } from "../../src/errors.js";

class FakeArtifactsError extends Error {
  constructor(readonly code: string) {
    super(`${code}: fake`);
  }
}

/** An in-memory stand-in for the Artifacts binding: one branch, files by path. */
function fakeArtifacts(options: { exists?: boolean; notReadyFor?: number } = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let exists = options.exists ?? true;
  let notReadyFor = options.notReadyFor ?? 0;
  const repo = {
    readFile: async ({ ref, path }: { ref: string; path: string }) => {
      calls.push(`readFile ${ref} ${path}`);
      const value = files.get(path);
      return value === undefined ? null : new Blob([value], { type: "text/plain" });
    },
    log: async (opts: { ref?: string; limit?: number }) => {
      calls.push(`log ${opts.ref} ${opts.limit}`);
      return [];
    },
    info: async () => ({ remote: "https://example.artifacts.cloudflare.net/git/ns/repo.git" }),
    createToken: async (scope: string, ttl: number) => {
      calls.push(`createToken ${scope} ${ttl}`);
      return { plaintext: "art_v1_secret?expires=123", expiresAt: "2026-10-07T00:00:00Z", scope, id: "t" };
    },
    [Symbol.dispose]: () => undefined,
  };
  const artifacts = {
    get: async (name: string) => {
      calls.push(`get ${name}`);
      if (!exists) throw new FakeArtifactsError("NOT_FOUND");
      if (notReadyFor > 0) {
        notReadyFor--;
        throw new FakeArtifactsError("CREATE_IN_PROGRESS");
      }
      return repo;
    },
    create: async (name: string, opts: { setDefaultBranch?: string }) => {
      calls.push(`create ${name} ${opts.setDefaultBranch}`);
      exists = true;
    },
    import: async (params: unknown) => {
      calls.push(`import ${JSON.stringify(params)}`);
      exists = true;
    },
  } as unknown as Artifacts;
  return { artifacts, files, calls };
}

/** A Durable Object namespace whose stub writes straight into the fake's files. */
function fakeWriters(files: Map<string, string>) {
  const writes: WriteTarget[] = [];
  const stub = {
    set: async (target: WriteTarget, key: string, value: string) => {
      writes.push(target);
      if (files.get(key) === value) return null;
      files.set(key, value);
      return "a".repeat(40);
    },
    delete: async (target: WriteTarget, key: string) => {
      writes.push(target);
      return files.delete(key) ? "b".repeat(40) : null;
    },
  };
  const ids: string[] = [];
  const writers = {
    idFromName: (name: string) => {
      ids.push(name);
      return name;
    },
    get: () => stub,
  } as unknown as WriterNamespace;
  return { writers, writes, ids };
}

describe("ChangeAgent", () => {
  it("round-trips values like the Ruby gem", async () => {
    const { artifacts, files, calls } = fakeArtifacts();
    const { writers, writes, ids } = fakeWriters(files);
    const agent = await ChangeAgent.init(artifacts, writers, "press-releases");

    const doc = await agent.set("foo/bar", "baz");
    expect(doc?.key).toBe("foo/bar");
    expect(doc?.commit).toBe("a".repeat(40));
    expect(doc?.text()).toBe("baz");
    expect(await agent.get("foo/bar")).toBe("baz");
    expect(calls).toContain("readFile main foo/bar");
    expect(await agent.set("foo/bar", "baz")).toBeNull();
    expect(await agent.delete("foo/bar")).toBe(true);
    expect(await agent.delete("foo/bar")).toBe(false);
    expect(await agent.get("foo/bar")).toBeNull();

    expect(ids.every((id) => id === "press-releases")).toBe(true);
    expect(writes[0]).toEqual({
      repo: "press-releases",
      branch: "main",
      author: { name: "Change Agent", email: "change-agent@users.noreply.github.com" },
    });
    expect(agent.inspect()).toBe('#<ChangeAgent::Client repo="press-releases">');
  });

  it("creates the repo on init when it doesn't exist", async () => {
    const { artifacts, calls } = fakeArtifacts({ exists: false });
    await ChangeAgent.init(artifacts, fakeWriters(new Map()).writers, "new-repo", { branch: "trunk" });
    expect(calls).toContain("create new-repo trunk");
  });

  it("waits while the repo is still being created", async () => {
    const { artifacts, calls } = fakeArtifacts({ notReadyFor: 2 });
    await ChangeAgent.init(artifacts, fakeWriters(new Map()).writers, "slow");
    expect(calls.filter((c) => c === "get slow")).toHaveLength(3);
  });

  it("gives up with RepoNotReadyError if the repo never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const { artifacts } = fakeArtifacts({ notReadyFor: Infinity });
      const init = ChangeAgent.init(artifacts, fakeWriters(new Map()).writers, "stuck");
      const assertion = expect(init).rejects.toBeInstanceOf(RepoNotReadyError);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("imports an existing repo", async () => {
    const { artifacts, calls } = fakeArtifacts({ exists: false });
    const agent = await ChangeAgent.import(artifacts, fakeWriters(new Map()).writers, "demo", {
      url: "https://github.com/benbalter/change_agent_demo",
      branch: "master",
    });
    expect(agent.branch).toBe("master");
    expect(calls.some((c) => c.startsWith("import ") && c.includes("change_agent_demo"))).toBe(true);
  });

  it("hands out a read-only remote with the token secret", async () => {
    const { artifacts, calls } = fakeArtifacts();
    const agent = await ChangeAgent.init(artifacts, fakeWriters(new Map()).writers, "repo");
    expect(await agent.remote()).toEqual({
      url: "https://example.artifacts.cloudflare.net/git/ns/repo.git",
      token: "art_v1_secret",
      expiresAt: "2026-10-07T00:00:00Z",
    });
    expect(calls).toContain("createToken read 3600");
  });

  it("validates keys before reading or writing", async () => {
    const { artifacts, files } = fakeArtifacts();
    const agent = await ChangeAgent.init(artifacts, fakeWriters(files).writers, "repo");
    await expect(agent.get("../etc/passwd")).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(agent.set("/abs", "x")).rejects.toBeInstanceOf(InvalidKeyError);
  });
});

describe("tokenSecret", () => {
  it("strips the expiry suffix", () => {
    expect(tokenSecret("art_v1_abc?expires=1760000000")).toBe("art_v1_abc");
    expect(tokenSecret("art_v1_abc")).toBe("art_v1_abc");
  });
});
