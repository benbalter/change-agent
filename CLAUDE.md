# CLAUDE.md

`change-agent` is a TypeScript library for Cloudflare Workers: a Git-backed key-value store where every value lives in a [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) repo and every change is a commit. It's the successor to the [`change_agent` Ruby gem](https://github.com/benbalter/change_agent). The [README](README.md) covers usage, how reads and writes work, and limits. It isn't published to npm: consumers run `npm install github:benbalter/change-agent`, and the `prepare` script builds `dist/` on install. Nothing here deploys a Worker.

## Commands

[ci.yml](.github/workflows/ci.yml) runs these on Node 24 after `npm ci`:

- `npm run lint`: ESLint, then `prettier --check .`, which covers Markdown too (`printWidth` 110, prose not wrapped). `npm run fix` applies both.
- `npm run typecheck`: `tsc --noEmit` over source and tests.
- `npm test`: two Vitest runs. First [`vitest.node.config.ts`](vitest.node.config.ts) runs [`test/node`](test/node) in Node, then [`vitest.config.ts`](vitest.config.ts) runs [`test/workers`](test/workers) inside workerd through `@cloudflare/vitest-plugin`. Both need the `git` CLI on `PATH`.
- `npm run build`: `tsc -p tsconfig.build.json` into `dist/`, which is gitignored.
- `npm run test:live` runs the Workers suite against real Artifacts with remote bindings ([`test/workers/wrangler.live.jsonc`](test/workers/wrangler.live.jsonc)). It needs a Workers Paid account with Artifacts access and creates real repos, so don't run it without the owner's go-ahead.

## Architecture

- [`src/client.ts`](src/client.ts): `ChangeAgent`, the public API (`init`, `import`, `get`, `getDocument`, `set`, `delete`, `log`, `remote`). Reads go straight to the Artifacts binding; writes go to the Durable Object.
- [`src/durable-object.ts`](src/durable-object.ts): `ChangeAgentDO`, one per repo, which queues writes one at a time so two never commit on the same parent.
- [`src/store.ts`](src/store.ts): `GitStore`, an in-memory shallow clone driven by isomorphic-git over [`src/fs.ts`](src/fs.ts) (memfs). It commits, pushes, and on a rejected push re-clones and tries again, up to `maxAttempts` (3 by default) before throwing `ConflictError`.
- [`src/artifacts.ts`](src/artifacts.ts): the Artifacts remote (short-lived tokens, error codes). [`src/keys.ts`](src/keys.ts): key validation. [`src/errors.ts`](src/errors.ts): exported error classes. [`src/index.ts`](src/index.ts) is the public surface.
- [`example/`](example/): a cron-triggered scraper Worker showing the `wrangler.jsonc` bindings a consumer needs.

## Testing against a stand-in

Miniflare can't emulate Artifacts (its binding only proxies to the real service), so [`test/support/git-server.ts`](test/support/git-server.ts) runs a real smart-HTTP Git server, using `node-git-server` and the `git` CLI, that also answers the binding's calls and checks tokens the way Artifacts does. [`test/workers/fake-artifacts.ts`](test/workers/fake-artifacts.ts) is the binding side. `vitest.config.ts` starts the server and passes its URL to workerd as `GIT_SERVER_URL`. The write path hasn't yet run against live Artifacts, so CI's confidence rests on the stand-in behaving like the real service. Change it only to match documented Artifacts behavior, not to make a test pass.

## Gotchas

- Write to the repo's default branch. A non-default branch on a repo whose default branch is empty fails to fetch ([isomorphic-git#1654](https://github.com/isomorphic-git/isomorphic-git/issues/1654)). Test repos are created on `main` so CI doesn't depend on the runner's git default.
- One repo's current files must fit in the Durable Object's 128 MB memory, since Artifacts has no partial clones.
- Renovate uses the shared `benbalter/renovate-config` preset (not `:instant`), and dependencies are pinned to exact versions.
