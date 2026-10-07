import { RepoNotReadyError } from "./errors.js";
import type { Remote } from "./store.js";

const TOKEN_TTL_SECONDS = 600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const NOT_READY = ["CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS"];

/**
 * The `ArtifactsError` code, if `error` is one. Codes may arrive as a property or,
 * after crossing an RPC boundary, only in the message, so check both.
 */
export function artifactsErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  const message = error instanceof Error ? error.message : String(error);
  return /\b([A-Z]+(?:_[A-Z]+)+)\b/.exec(message)?.[1];
}

/** Run `fn` with a repo handle, disposing the RPC stub afterwards. */
export async function withRepo<T>(
  artifacts: Artifacts,
  name: string,
  fn: (repo: ArtifactsRepo) => Promise<T>,
): Promise<T> {
  let repo: ArtifactsRepo;
  try {
    repo = await artifacts.get(name);
  } catch (error) {
    const code = artifactsErrorCode(error);
    if (code && NOT_READY.includes(code)) {
      throw new RepoNotReadyError(`Artifacts repo ${name} isn't ready yet (${code})`);
    }
    throw error;
  }
  try {
    return await fn(repo);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

/** Strip the `?expires=…` suffix: Git wants only the secret as the Basic auth password. */
export function tokenSecret(token: string): string {
  return token.split("?expires=")[0]!;
}

/**
 * A Remote backed by an Artifacts repo. The remote head comes from the binding's
 * `log()` (no Git round trip), and writes use short-lived, cached write tokens.
 */
export class ArtifactsRemote implements Remote {
  readonly #artifacts: Artifacts;
  readonly #name: string;
  #url: string | null = null;
  #token: { secret: string; expiresAt: number } | null = null;

  constructor(artifacts: Artifacts, name: string) {
    this.#artifacts = artifacts;
    this.#name = name;
  }

  async url(): Promise<string> {
    this.#url ??= await withRepo(this.#artifacts, this.#name, async (repo) => (await repo.info()).remote);
    return this.#url;
  }

  async auth() {
    if (!this.#token || this.#token.expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      const token = await withRepo(this.#artifacts, this.#name, (repo) =>
        repo.createToken("write", TOKEN_TTL_SECONDS),
      );
      this.#token = { secret: tokenSecret(token.plaintext), expiresAt: Date.parse(token.expiresAt) };
    }
    return { username: "x", password: this.#token.secret };
  }

  async head(branch: string): Promise<string | null> {
    const [commit] = await withRepo(this.#artifacts, this.#name, (repo) =>
      repo.log({ ref: branch, limit: 1 }),
    );
    return commit?.hash ?? null;
  }
}
