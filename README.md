# Change Agent

_A Git-backed key-value store on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/), for tracking changes to documents and other files over time._

This is the TypeScript successor to the [`change_agent` Ruby gem](https://github.com/benbalter/change_agent). Same idea, new home: instead of a local Git repo managed with Rugged, every value lives in an Artifacts repo, and every change is a commit.

### A git-backed key value store sounds like a terrible idea. Why would you do that?

Let's say you're building a scraper to see when Members of Congress post press releases to their websites and to track how those press releases change over time. You could build a purpose-built application, store each revision in a database, and then build an interface to view all the known press releases and compare their history. Stop the insanity!

But wait. What if you just committed each press release to Git, and let Git do the heavy lifting? Every change gets a snapshot and a timestamp, you can diff exactly how something changed, and any Git client can clone the whole history.

## Okay, I'm sold. How do I use it?

Change Agent runs inside a Cloudflare Worker. It isn't on npm, so install it from GitHub (the `prepare` script builds it on install):

```sh
npm install github:benbalter/change-agent
```

Add an Artifacts binding and the Change Agent Durable Object to your `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "default" }],
  "durable_objects": {
    "bindings": [{ "name": "CHANGE_AGENT", "class_name": "ChangeAgentDO" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChangeAgentDO"] }],
}
```

Then re-export the Durable Object from your Worker and use it:

```ts
import { ChangeAgent } from "change-agent";
export { ChangeAgentDO } from "change-agent";

const agent = await ChangeAgent.init(env.ARTIFACTS, env.CHANGE_AGENT, "press-releases");

await agent.set("foo", "bar"); // => Document { key: "foo", commit: "3f2a…" }
await agent.get("foo"); // => "bar"
await agent.set("foo", "bar"); // => null (unchanged, so no commit)
await agent.delete("foo"); // => true
```

`init` creates the repo if it doesn't exist. See [`example/`](example/) for a complete scraper that runs on a cron trigger.

### Namespaced usage

Keys are file paths, so namespace them when they're logically grouped. If you were storing congressional press releases, you might store Rep. Balter's Nov 26th press release on puppies as `balter/2014/11/26/puppies.html`, or just `balter/2014-11-26-puppies.txt`, or even just `balter/puppies`.

```ts
await agent.set("balter/2014/11/26/puppies.html", html);
await agent.get("balter/2014/11/26/puppies.html");
```

Think about what you want the repo to look like when you browse it, and work backwards from there. Artifacts repos are cheap and unlimited, so you can also use a repo per source (`ChangeAgent.init(..., "balter")`) instead of one big one.

### Binary values

`set` takes a string or a `Uint8Array`. `get` returns text; use `getDocument(key)` for the raw bytes (`doc.bytes`) and the MIME type Artifacts infers from the extension (`doc.type`).

### History

```ts
await agent.log({ limit: 10 }); // commits on the branch, newest first
```

Each commit is `Updating <key>` or `Removing <key>`. For diffs and per-file history, clone the repo:

```ts
const { url, token } = await agent.remote(); // read-only, expires in an hour
```

```sh
git -c http.extraHeader="Authorization: Bearer $TOKEN" clone "$URL"
git log -p -- balter/2014/11/26/puppies.html
```

### Importing an existing datastore

To carry over a repo built with the Ruby gem (or any public Git repo):

```ts
const agent = await ChangeAgent.import(env.ARTIFACTS, env.CHANGE_AGENT, "demo", {
  url: "https://github.com/benbalter/change_agent_demo",
  branch: "master",
});
```

### Options

```ts
ChangeAgent.init(env.ARTIFACTS, env.CHANGE_AGENT, "press-releases", {
  branch: "main", // default
  author: { name: "Press Release Bot", email: "bot@example.com" },
});
```

`ChangeAgentDO` reads the Artifacts binding from `env.ARTIFACTS`. To use a different binding name, subclass it and override `artifacts()`.

## How it works

The [Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) can read files and history, but it can't commit. Commits go over the Git protocol. So:

- **Reads** (`get`, `getDocument`, `log`) go straight to the binding, with no Git client involved.
- **Writes** (`set`, `delete`) go to a `ChangeAgentDO` Durable Object, one per repo. It keeps a shallow clone of the branch in memory and uses [isomorphic-git](https://isomorphic-git.org/) to commit and push with a short-lived write token. Writes are queued one at a time, so two of them never commit on the same parent.
- If something else pushed to the repo in the meantime, for example a `git push` from your laptop, the push is rejected. The Durable Object then re-clones, reapplies the one change, and retries up to three times before throwing `ConflictError`.

## Limits and costs

- The Durable Object holds the tip of the branch in memory, and Artifacts doesn't support partial clones. So one repo's current files need to fit comfortably within the [128 MB memory limit](https://developers.cloudflare.com/workers/platform/limits/) of the isolate it runs in. If you're tracking more than that, split into more repos.
- Write to the repo's default branch (the default when you don't pass `branch`). If you pick another branch while the default one is still empty, the repo's `HEAD` points at a branch that doesn't exist, and isomorphic-git can't fetch from it ([isomorphic-git#1654](https://github.com/isomorphic-git/isomorphic-git/issues/1654)).
- Artifacts caps repos at 1 GB and files at 32 MB ([limits](https://developers.cloudflare.com/artifacts/platform/limits/)).
- Artifacts requires the Workers Paid plan and is billed per operation and per GB-month of storage ([pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)). A write uses several operations: a head check, a token when the cached one expires, a clone when the cache is cold, and the push. A read uses one.

## Coming from the Ruby gem

| Ruby                                      | TypeScript                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `ChangeAgent.init("path/to/repo")`        | `await ChangeAgent.init(env.ARTIFACTS, env.CHANGE_AGENT, "repo")`           |
| `ChangeAgent::Client.new(dir, remote)`    | `await ChangeAgent.import(..., { url: remote })`                            |
| `set` / `get` / `delete` / `get_document` | `set` / `get` / `delete` / `getDocument` (all async)                        |
| `push` / `pull` / `sync` / `add_remote`   | Not needed: the Artifacts repo _is_ the remote. Use `remote()` to clone it. |
| `GITHUB_TOKEN` credentials                | Short-lived Artifacts tokens, minted for you                                |

## Project status

Early. Artifacts itself is in open beta. The write path is tested against a local Git server and the Workers runtime, but hasn't yet been run against live Artifacts.

## Development

```sh
npm install
npm test           # everything below, with a local stand-in for Artifacts
npm run lint
npm run typecheck
npm run test:live  # the end-to-end suite against real Artifacts (needs Workers Paid with Artifacts access)
```

Miniflare can't emulate Artifacts locally (its Artifacts binding only proxies to the real service), so the tests bring their own stand-in. [`test/support/git-server.ts`](test/support/git-server.ts) is a real smart-HTTP Git server that also answers the binding's calls (read a file, log, issue a token) using the `git` CLI, and checks tokens the way Artifacts does. [`test/workers/fake-artifacts.ts`](test/workers/fake-artifacts.ts) is the binding side of it.

- [`test/node`](test/node): `GitStore` against that server, checked with the `git` CLI.
- [`test/workers`](test/workers): runs in workerd, end to end, from the client through the Durable Object and a push, then reads back through the binding. `npm run test:live` runs the same suite against real Artifacts, which also checks that the stand-in behaves like the real thing.

## License

MIT
