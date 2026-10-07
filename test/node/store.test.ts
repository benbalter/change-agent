import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import http from "isomorphic-git/http/node";
import type { HttpClient } from "isomorphic-git";
import { Git } from "node-git-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, InvalidKeyError } from "../../src/errors.js";
import { GitStore, httpRemote, type Remote } from "../../src/store.js";

// A real smart-HTTP Git server (git-upload-pack / git-receive-pack) over temp bare repos.
let root: string;
let server: Git;
let baseUrl: string;
let url: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "change-agent-"));
  server = new Git(root, { autoCreate: true });
  await new Promise<void>((resolve) => server.listen(0, { type: "http" }, resolve));
  baseUrl = `http://127.0.0.1:${(server.server!.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  url = `${baseUrl}/${randomUUID()}.git`;
});

const remote = () => httpRemote(url);
const store = (r: Remote = remote(), options: { maxAttempts?: number; http?: HttpClient } = {}) =>
  new GitStore({ remote: r, http, ...options });

/**
 * Clone the remote with the git CLI, so assertions don't trust isomorphic-git.
 * Async on purpose: the server runs in this process, so a sync clone would deadlock.
 */
async function cliClone(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "change-agent-clone-"));
  await promisify(execFile)("git", ["clone", "-q", url, dir]);
  return dir;
}
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args])
    .toString()
    .trim();
const messages = (dir: string) => gitIn(dir, "log", "--format=%s").split("\n");

describe("GitStore", () => {
  it("commits a value to an empty remote", async () => {
    const commit = await store().set("foo", "bar");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    const dir = await cliClone();
    expect(gitIn(dir, "show", "HEAD:foo")).toBe("bar");
    expect(messages(dir)).toEqual(["Updating foo"]);
    expect(gitIn(dir, "log", "--format=%an <%ae>")).toBe(
      "Change Agent <change-agent@users.noreply.github.com>",
    );
  });

  it("returns null and makes no commit when the value is unchanged", async () => {
    const s = store();
    await s.set("foo", "bar");
    expect(await s.set("foo", "bar")).toBeNull();
    // A fresh store (cold clone) sees the same thing.
    expect(await store().set("foo", "bar")).toBeNull();
    expect(messages(await cliClone())).toEqual(["Updating foo"]);
  });

  it("updates, namespaces, and deletes keys", async () => {
    const s = store();
    await s.set("foo", "bar");
    await s.set("foo", "baz");
    await s.set("balter/2014/11/26/puppies.html", "<p>puppies</p>");
    expect(await s.delete("foo")).toMatch(/^[0-9a-f]{40}$/);
    expect(await s.delete("foo")).toBeNull();

    const dir = await cliClone();
    expect(gitIn(dir, "show", "HEAD:balter/2014/11/26/puppies.html")).toBe("<p>puppies</p>");
    expect(gitIn(dir, "ls-files")).toBe("balter/2014/11/26/puppies.html");
    expect(messages(dir)).toEqual([
      "Removing foo",
      "Updating balter/2014/11/26/puppies.html",
      "Updating foo",
      "Updating foo",
    ]);
  });

  it("stores binary values byte for byte", async () => {
    const bytes = new Uint8Array([0, 255, 1, 254, 10, 13]);
    await store().set("blob.bin", bytes);
    const dir = await cliClone();
    expect(new Uint8Array(execFileSync("git", ["-C", dir, "show", "HEAD:blob.bin"]))).toEqual(bytes);
  });

  it("serializes concurrent writes so none are lost", async () => {
    const s = store();
    await s.set("seed", "0");
    const keys = Array.from({ length: 5 }, (_, i) => `concurrent/${i}`);
    await Promise.all(keys.map((k) => s.set(k, k)));
    const dir = await cliClone();
    for (const k of keys) expect(gitIn(dir, "show", `HEAD:${k}`)).toBe(k);
    expect(messages(dir)).toHaveLength(6);
  });

  it("notices pushes from other writers before deciding a value is unchanged", async () => {
    const a = store();
    const b = store();
    await a.set("foo", "one");
    await b.set("foo", "two");
    // a's cached clone still says "one"; it must re-sync rather than skip.
    expect(await a.set("foo", "one")).not.toBeNull();
    expect(gitIn(await cliClone(), "show", "HEAD:foo")).toBe("one");
  });

  it("rebuilds from the server's head when a push is rejected", async () => {
    await store().set("other", "x");
    // A head hint that lags behind (says the branch is empty), so the first commit
    // lands on the wrong parent and the push is rejected.
    const lagging: Remote = { ...remote(), head: async () => null };
    expect(await store(lagging).set("foo", "bar")).not.toBeNull();
    const dir = await cliClone();
    expect(gitIn(dir, "show", "HEAD:foo")).toBe("bar");
    expect(gitIn(dir, "show", "HEAD:other")).toBe("x");
  });

  it("throws ConflictError when another writer wins every race", async () => {
    await store().set("seed", "0");
    // Just before each of our pushes, a different writer pushes first.
    const racing: HttpClient = {
      async request(req) {
        if (req.method === "POST" && req.url.endsWith("/git-receive-pack")) {
          await store().set("race", randomUUID());
        }
        return http.request(req);
      },
    };
    await expect(store(remote(), { maxAttempts: 2, http: racing }).set("foo", "bar")).rejects.toBeInstanceOf(
      ConflictError,
    );
    // The lock is released after a failure.
    expect(await store().set("foo", "bar")).not.toBeNull();
  });

  it("doesn't retry errors that aren't push rejections", async () => {
    const unreachable = httpRemote("http://127.0.0.1:1/nope.git");
    await expect(store(unreachable).set("foo", "bar")).rejects.not.toBeInstanceOf(ConflictError);
  });

  it("rejects unsafe keys before touching the remote", async () => {
    for (const key of ["", "/abs", "a//b", "../up", "a/./b", ".git/config", "a/.GIT/b", "trailing/"]) {
      expect(() => store().set(key, "x")).toThrow(InvalidKeyError);
    }
  });
});
