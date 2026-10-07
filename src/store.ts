import git from "isomorphic-git";
import type { GitAuth, HttpClient, PromiseFsClient } from "isomorphic-git";
import { ConflictError } from "./errors.js";
import { createMemoryFs } from "./fs.js";
import { assertValidKey } from "./keys.js";

/** The commit author. isomorphic-git refuses to commit without one. */
export interface Author {
  name: string;
  email: string;
}

export const DEFAULT_AUTHOR: Author = {
  name: "Change Agent",
  email: "change-agent@users.noreply.github.com",
};

/**
 * Where the store clones from and pushes to. Each method is called fresh for every
 * write, so implementations can mint short-lived credentials.
 */
export interface Remote {
  url(): Promise<string>;
  auth(): Promise<GitAuth>;
  /**
   * The commit the branch points to on the remote, or null if the branch doesn't exist
   * yet. Only a fast-path hint: after a rejected push, the store asks the Git server.
   */
  head?(branch: string): Promise<string | null>;
}

export interface GitStoreOptions {
  remote: Remote;
  http: HttpClient;
  /** Defaults to "main". */
  branch?: string;
  /** How many times to rebuild and retry a rejected push before giving up. Defaults to 3. */
  maxAttempts?: number;
}

export type Value = string | Uint8Array;

const DIR = "/repo";
const encoder = new TextEncoder();

/**
 * A single-branch working copy that turns key-value writes into commits.
 *
 * It keeps a shallow (depth 1) clone in memory between writes, and serializes
 * writes so two of them never commit on the same parent. Before each write it
 * checks the remote head; if something else pushed, it re-clones first.
 */
export class GitStore {
  readonly branch: string;
  readonly #remote: Remote;
  readonly #http: HttpClient;
  readonly #maxAttempts: number;
  #fs: PromiseFsClient | null = null;
  #head: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: GitStoreOptions) {
    this.#remote = options.remote;
    this.#http = options.http;
    this.branch = options.branch ?? "main";
    this.#maxAttempts = options.maxAttempts ?? 3;
  }

  /**
   * Write `value` at `key` and commit `Updating {key}`.
   * Returns the new commit's ID, or null when the stored value was already identical.
   */
  set(key: string, value: Value, author: Author = DEFAULT_AUTHOR): Promise<string | null> {
    assertValidKey(key);
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    return this.#write(key, author, async (fs, current) => {
      if (current !== null && equalBytes(current, bytes)) return false;
      await mkdirp(fs, parentDir(`${DIR}/${key}`));
      await fs.promises.writeFile(`${DIR}/${key}`, bytes);
      await git.add({ fs, dir: DIR, filepath: key });
      return `Updating ${key}`;
    });
  }

  /**
   * Remove `key` and commit `Removing {key}`.
   * Returns the new commit's ID, or null when the key didn't exist.
   */
  delete(key: string, author: Author = DEFAULT_AUTHOR): Promise<string | null> {
    assertValidKey(key);
    return this.#write(key, author, async (fs, current) => {
      if (current === null) return false;
      await fs.promises.unlink(`${DIR}/${key}`);
      await git.remove({ fs, dir: DIR, filepath: key });
      return `Removing ${key}`;
    });
  }

  /** Drop the cached clone, so the next write starts from a fresh one. */
  reset(): void {
    this.#fs = null;
    this.#head = null;
  }

  /**
   * Run one write under the lock. `apply` edits the working copy and returns the
   * commit message, or false when there's nothing to commit.
   */
  #write(
    key: string,
    author: Author,
    apply: (fs: PromiseFsClient, current: Uint8Array | null) => Promise<string | false>,
  ): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
        try {
          // After a rejection, don't trust the hint: it's what just led us astray.
          const fs = await this.#sync(attempt === 1);
          const message = await apply(fs, await readFile(fs, key));
          if (message === false) return null;

          const commit = await git.commit({ fs, dir: DIR, message, author });
          const result = await git.push({
            fs,
            http: this.#http,
            dir: DIR,
            url: await this.#remote.url(),
            ref: this.branch,
            onAuth: () => this.#remote.auth(),
          });
          if (!result.ok) {
            throw new git.Errors.PushRejectedError("not-fast-forward");
          }
          this.#head = commit;
          return commit;
        } catch (error) {
          // Whatever failed, the working copy may now hold a commit the remote
          // doesn't, so throw it away rather than build on it.
          this.reset();
          if (!isRejectedPush(error)) throw error;
          lastError = error;
        }
      }
      throw new ConflictError(
        `Couldn't push ${key} after ${this.#maxAttempts} attempts: ${String(lastError)}`,
      );
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Make sure the working copy matches the remote head, re-cloning if it doesn't. */
  async #sync(useHint: boolean): Promise<PromiseFsClient> {
    const head =
      useHint && this.#remote.head ? await this.#remote.head(this.branch) : await this.#serverHead();
    if (this.#fs && this.#head === head) return this.#fs;

    const fs = createMemoryFs();
    if (head === null) {
      await git.init({ fs, dir: DIR, defaultBranch: this.branch });
    } else {
      await git.clone({
        fs,
        http: this.#http,
        dir: DIR,
        url: await this.#remote.url(),
        ref: this.branch,
        singleBranch: true,
        depth: 1,
        noTags: true,
        onAuth: () => this.#remote.auth(),
      });
    }
    this.#fs = fs;
    this.#head = head;
    return fs;
  }

  /** Ask the Git server itself where the branch points. */
  async #serverHead(): Promise<string | null> {
    const ref = `refs/heads/${this.branch}`;
    const refs = await git.listServerRefs({
      http: this.#http,
      url: await this.#remote.url(),
      prefix: ref,
      protocolVersion: 1,
      onAuth: () => this.#remote.auth(),
    });
    return refs.find((r) => r.ref === ref)?.oid ?? null;
  }
}

/** A Remote for any smart-HTTP Git server. */
export function httpRemote(url: string, auth: GitAuth = {}): Remote {
  return { url: async () => url, auth: async () => auth };
}

/**
 * isomorphic-git reports a lost race two ways: PushRejectedError when it can tell
 * client-side, GitPushError when the server refuses the ref update.
 */
function isRejectedPush(error: unknown): boolean {
  return error instanceof git.Errors.PushRejectedError || error instanceof git.Errors.GitPushError;
}

async function readFile(fs: PromiseFsClient, key: string): Promise<Uint8Array | null> {
  try {
    return (await fs.promises.readFile(`${DIR}/${key}`)) as Uint8Array;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

async function mkdirp(fs: PromiseFsClient, path: string): Promise<void> {
  if (path === DIR) return;
  await fs.promises.mkdir(path, { recursive: true });
}

function parentDir(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
