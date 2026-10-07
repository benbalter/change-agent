import { Volume, createFsFromVolume } from "memfs";
import type { PromiseFsClient } from "isomorphic-git";

/** A fresh in-memory filesystem for one working copy. */
export function createMemoryFs(): PromiseFsClient {
  return createFsFromVolume(new Volume()) as unknown as PromiseFsClient;
}
