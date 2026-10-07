// A stand-in for the Artifacts binding, backed by test/support/git-server.ts.
// Only what change-agent uses is implemented; the rest throws.

class FakeArtifactsError extends Error {
  override readonly name = "ArtifactsError";
  constructor(readonly code: string) {
    super(`${code}: fake Artifacts`);
  }
}

async function call(base: string, method: string, path: string, params: Record<string, unknown>) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
  const response = await fetch(`${base}/_artifacts/${path}?${query}`, { method });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new FakeArtifactsError(body.error ?? "INTERNAL_ERROR");
  }
  return response;
}

const notImplemented = () => {
  throw new Error("Not implemented by the fake Artifacts binding");
};

class FakeRepo {
  constructor(
    private readonly base: string,
    private readonly name: string,
  ) {}

  async info(): Promise<ArtifactsRepoInfo> {
    const { defaultBranch } = (await (await call(this.base, "GET", "info", { name: this.name })).json()) as {
      defaultBranch: string;
    };
    const now = new Date().toISOString();
    return {
      id: this.name,
      name: this.name,
      description: null,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
      lastPushAt: null,
      source: null,
      readOnly: false,
      remote: `${this.base}/${this.name}.git`,
    };
  }

  async createToken(scope: "read" | "write" = "write", ttl = 86400): Promise<ArtifactsCreateTokenResult> {
    return (await call(this.base, "POST", "token", { name: this.name, scope, ttl })).json();
  }

  async readFile({ ref, path }: { ref: string; path: string }): Promise<Blob | null> {
    try {
      return await (await call(this.base, "GET", "read", { name: this.name, ref, path })).blob();
    } catch (error) {
      if ((error as FakeArtifactsError).code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async log(
    opts: { ref?: string; limit?: number; offset?: number } = {},
  ): Promise<ArtifactsCommitMetadata[]> {
    return (await call(this.base, "GET", "log", { name: this.name, ...opts })).json();
  }

  listTokens = notImplemented;
  revokeToken = notImplemented;
  readBlob = notImplemented;
  readTree = notImplemented;
  readCommit = notImplemented;
  fork = notImplemented;
  [Symbol.dispose]() {}
}

export class FakeArtifacts {
  constructor(private readonly base: string) {}

  async get(name: string): Promise<ArtifactsRepo> {
    await call(this.base, "GET", "info", { name });
    return new FakeRepo(this.base, name) as unknown as ArtifactsRepo;
  }

  async create(name: string, opts: { setDefaultBranch?: string } = {}): Promise<ArtifactsCreateRepoResult> {
    await call(this.base, "POST", "create", { name, branch: opts.setDefaultBranch });
    return this.#created(name);
  }

  async import(params: {
    source: { url: string; branch?: string };
    target: { name: string };
  }): Promise<ArtifactsCreateRepoResult> {
    const { source, target } = params;
    await call(this.base, "POST", "import", { name: target.name, url: source.url, branch: source.branch });
    return this.#created(target.name);
  }

  async delete(name: string): Promise<boolean> {
    return ((await (await call(this.base, "POST", "delete", { name })).json()) as { deleted: boolean })
      .deleted;
  }

  list = notImplemented;

  async #created(name: string): Promise<ArtifactsCreateRepoResult> {
    const repo = new FakeRepo(this.base, name);
    const info = await repo.info();
    const token = await repo.createToken();
    return { ...info, token: token.plaintext };
  }
}
