/** Base class for errors thrown by change-agent. */
export class ChangeAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The key isn't a safe, repository-relative path. */
export class InvalidKeyError extends ChangeAgentError {}

/**
 * The write couldn't land because the remote branch kept moving underneath it
 * (for example, someone pushing with a plain Git client) and every retry lost the race.
 */
export class ConflictError extends ChangeAgentError {}

/** The Artifacts repo is still being created, imported, or forked. */
export class RepoNotReadyError extends ChangeAgentError {}
