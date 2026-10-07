import { DurableObject } from "cloudflare:workers";
import http from "isomorphic-git/http/web";
import { ArtifactsRemote } from "./artifacts.js";
import { GitStore, type Author, type Value } from "./store.js";

export interface WriteTarget {
  /** Artifacts repo name. */
  repo: string;
  branch: string;
  author: Author;
}

/**
 * Serializes writes to one Artifacts repo. The Artifacts binding can read but not
 * commit, so writes go over Git; routing them all through one Durable Object per
 * repo keeps two writers from committing on the same parent.
 *
 * Re-export this from your Worker and bind it as a Durable Object. It reads the
 * Artifacts binding from `env.ARTIFACTS`; subclass and override `artifacts()` to
 * use a different binding name.
 */
export class ChangeAgentDO<Env = unknown> extends DurableObject<Env> {
  readonly #stores = new Map<string, GitStore>();

  protected artifacts(): Artifacts {
    const binding = (this.env as { ARTIFACTS?: Artifacts }).ARTIFACTS;
    if (!binding) {
      throw new Error("ChangeAgentDO needs an Artifacts binding named ARTIFACTS (or override artifacts())");
    }
    return binding;
  }

  /** Returns the new commit ID, or null when nothing changed. */
  async set(target: WriteTarget, key: string, value: Value): Promise<string | null> {
    return this.#store(target).set(key, value, target.author);
  }

  /** Returns the new commit ID, or null when the key didn't exist. */
  async delete(target: WriteTarget, key: string): Promise<string | null> {
    return this.#store(target).delete(key, target.author);
  }

  #store({ repo, branch }: WriteTarget): GitStore {
    const id = `${repo}\0${branch}`;
    let store = this.#stores.get(id);
    if (!store) {
      store = new GitStore({ remote: new ArtifactsRemote(this.artifacts(), repo), http, branch });
      this.#stores.set(id, store);
    }
    return store;
  }
}
