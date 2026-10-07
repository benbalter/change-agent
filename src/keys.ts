import { InvalidKeyError } from "./errors.js";

const MAX_KEY_LENGTH = 4096;

/**
 * Keys are file paths in the repo, so reject anything Git or a checkout would
 * treat specially: absolute paths, empty or relative segments, and `.git`.
 */
export function assertValidKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidKeyError("Key must be a non-empty string");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidKeyError(`Key must be at most ${MAX_KEY_LENGTH} characters`);
  }
  if (key.includes("\0") || key.includes("\\")) {
    throw new InvalidKeyError(`Key contains an invalid character: ${JSON.stringify(key)}`);
  }
  for (const segment of key.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new InvalidKeyError(`Key has an empty or relative path segment: ${JSON.stringify(key)}`);
    }
    if (segment.toLowerCase() === ".git") {
      throw new InvalidKeyError(`Key may not contain a .git segment: ${JSON.stringify(key)}`);
    }
  }
}
