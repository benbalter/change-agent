import { artifactsErrorCode, tokenSecret, withRepo } from "./artifacts.js";
import type { ChangeAgentDO, WriteTarget } from "./durable-object.js";
import { Document } from "./document.js";
import { RepoNotReadyError } from "./errors.js";
import { assertValidKey } from "./keys.js";
import { DEFAULT_AUTHOR, type Author, type Value } from "./store.js";

export interface ChangeAgentOptions {
  /** Branch to read from and commit to. Defaults to "main". */
  branch?: string;
  /** Commit author. Defaults to "Change Agent <change-agent@users.noreply.github.com>". */
  author?: Author;
}

export interface ImportSource {
  /** HTTPS URL of a public Git repo, such as an existing change_agent data repo on GitHub. */
  url: string;
  branch?: string;
  /** Shallow-import only this many commits of history. */
  depth?: number;
}

export interface RemoteAccess {
  /** HTTPS Git remote URL for the repo. */
  url: string;
  /** Token secret. Use it as a Bearer token or as the Basic auth password. */
  token: string;
  expiresAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WriterNamespace = DurableObjectNamespace<ChangeAgentDO<any>>;

const encoder = new TextEncoder();
const READY_ATTEMPTS = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Git-backed key-value store on Cloudflare Artifacts. Every change is a commit,
 * so each value gets a snapshot and a timestamp for free.
 *
 * Reads go straight to the Artifacts binding. Writes go to a ChangeAgentDO, which
 * commits and pushes over Git.
 */
export class ChangeAgent {
  readonly name: string;
  readonly branch: string;
  readonly author: Author;
  readonly #artifacts: Artifacts;
  readonly #writers: WriterNamespace;

  constructor(
    artifacts: Artifacts,
    writers: WriterNamespace,
    name: string,
    options: ChangeAgentOptions = {},
  ) {
    this.#artifacts = artifacts;
    this.#writers = writers;
    this.name = name;
    this.branch = options.branch ?? "main";
    this.author = options.author ?? DEFAULT_AUTHOR;
  }

  /** Open the repo called `name`, creating it if it doesn't exist. */
  static async init(
    artifacts: Artifacts,
    writers: WriterNamespace,
    name: string,
    options: ChangeAgentOptions = {},
  ): Promise<ChangeAgent> {
    const branch = options.branch ?? "main";
    await waitForRepo(artifacts, name, async () => {
      await artifacts.create(name, { setDefaultBranch: branch });
    });
    return new ChangeAgent(artifacts, writers, name, options);
  }

  /** Create the repo `name` as a copy of an existing Git repo, then open it. */
  static async import(
    artifacts: Artifacts,
    writers: WriterNamespace,
    name: string,
    source: ImportSource,
    options: ChangeAgentOptions = {},
  ): Promise<ChangeAgent> {
    await waitForRepo(artifacts, name, async () => {
      await artifacts.import({ source, target: { name } });
    });
    return new ChangeAgent(artifacts, writers, name, { branch: source.branch, ...options });
  }

  /** The value at `key` as text, or null if there isn't one. */
  async get(key: string): Promise<string | null> {
    return (await this.getDocument(key))?.text() ?? null;
  }

  async getDocument(key: string): Promise<Document | null> {
    assertValidKey(key);
    const blob = await withRepo(this.#artifacts, this.name, (repo) =>
      repo.readFile({ ref: this.branch, path: key }),
    );
    if (!blob) return null;
    return new Document(key, new Uint8Array(await blob.arrayBuffer()), null, blob.type);
  }

  /**
   * Store `value` at `key` and commit it. Returns null without committing when the
   * stored value is already identical.
   */
  async set(key: string, value: Value): Promise<Document | null> {
    assertValidKey(key);
    const commit = await this.#writer().set(this.#target(), key, value);
    if (commit === null) return null;
    return new Document(key, typeof value === "string" ? encoder.encode(value) : value, commit);
  }

  /** Remove `key` and commit. Returns false if it didn't exist. */
  async delete(key: string): Promise<boolean> {
    assertValidKey(key);
    return (await this.#writer().delete(this.#target(), key)) !== null;
  }

  /** Commits on the branch, newest first. */
  async log(options: { limit?: number; offset?: number } = {}): Promise<ArtifactsCommitMetadata[]> {
    return withRepo(this.#artifacts, this.name, (repo) => repo.log({ ref: this.branch, ...options }));
  }

  /**
   * A Git URL and short-lived token, for handing the store to `git clone` or another
   * tool. Read-only unless you ask for write access.
   */
  async remote(options: { scope?: "read" | "write"; ttl?: number } = {}): Promise<RemoteAccess> {
    return withRepo(this.#artifacts, this.name, async (repo) => {
      const { remote } = await repo.info();
      const token = await repo.createToken(options.scope ?? "read", options.ttl ?? 3600);
      return { url: remote, token: tokenSecret(token.plaintext), expiresAt: token.expiresAt };
    });
  }

  inspect(): string {
    return `#<ChangeAgent::Client repo="${this.name}">`;
  }

  #writer() {
    return this.#writers.get(this.#writers.idFromName(this.name));
  }

  #target(): WriteTarget {
    return { repo: this.name, branch: this.branch, author: this.author };
  }
}

/**
 * Wait until the repo exists and is ready, calling `create` once if it's missing.
 * Creation, import, and fork finish asynchronously, so back off while they run.
 */
async function waitForRepo(artifacts: Artifacts, name: string, create: () => Promise<void>): Promise<void> {
  let created = false;
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    try {
      await withRepo(artifacts, name, async () => undefined);
      return;
    } catch (error) {
      if (artifactsErrorCode(error) === "NOT_FOUND" && !created) {
        created = true;
        try {
          await create();
        } catch (createError) {
          if (artifactsErrorCode(createError) !== "ALREADY_EXISTS") throw createError;
        }
        continue;
      }
      if (!(error instanceof RepoNotReadyError) && artifactsErrorCode(error) !== "NOT_FOUND") throw error;
    }
    await sleep(100 * 2 ** attempt);
  }
  throw new RepoNotReadyError(`Artifacts repo ${name} wasn't ready after ${READY_ATTEMPTS} attempts`);
}
