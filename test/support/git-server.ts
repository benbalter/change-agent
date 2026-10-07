import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { Git } from "node-git-server";

const run = promisify(execFile);

export interface GitServer {
  url: string;
  /** Create a bare repo whose HEAD is `branch`. Returns its clone URL. */
  createRepo(name: string, branch?: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * A local stand-in for Cloudflare Artifacts, for tests.
 *
 * - `/<name>.git/...` is a real smart-HTTP Git server (git-upload-pack / git-receive-pack).
 *   Once a token has been issued for a repo, Git requests to it must use one, the way
 *   Artifacts does: Basic auth with the token secret (no `?expires=` suffix) as the
 *   password, and a write token to push.
 * - `/_artifacts/...` answers the calls the Artifacts binding makes (create, import,
 *   info, readFile, log, createToken, delete) using the git CLI, so the fake binding
 *   in test/integration doesn't share any code with the isomorphic-git write path.
 */
export async function startGitServer(): Promise<GitServer> {
  const root = mkdtempSync(join(tmpdir(), "change-agent-server-"));
  const tokens = new Map<string, { repo: string; scope: "read" | "write" }>();
  const reposWithTokens = new Set<string>();
  const dirFor = (name: string) => join(root, `${name}.git`);
  const git = (name: string, ...args: string[]) => run("git", ["--git-dir", dirFor(name), ...args]);

  const repos = new Git(root, {
    autoCreate: false,
    authenticate: async ({ type, repo, user }) => {
      const name = repo.replace(/\.git$/, "");
      if (!reposWithTokens.has(name)) return;
      const [, password] = await user();
      const token = password ? tokens.get(password) : undefined;
      if (!token || token.repo !== name) throw new Error(`Invalid token for ${name}`);
      if (type === "push" && token.scope !== "write") throw new Error("Read-only token can't push");
    },
  });

  async function createRepo(name: string, branch = "main") {
    await run("git", ["init", "--bare", "-q", "-b", branch, dirFor(name)]);
    return `${url}/${name}.git`;
  }

  async function control(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams) {
    const name = q.get("name") ?? "";
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const error = (status: number, code: string) => json(status, { error: code });
    const exists = name !== "" && existsSync(dirFor(name));

    switch (`${req.method} ${path}`) {
      case "POST /create": {
        if (exists) return error(409, "ALREADY_EXISTS");
        await createRepo(name, q.get("branch") ?? "main");
        return json(200, { ok: true });
      }
      case "POST /import": {
        if (exists) return error(409, "ALREADY_EXISTS");
        // Clone this server's own repos straight from disk, as Artifacts would
        // import a repo it already hosts without needing a token.
        const sourceUrl = q.get("url")!;
        const local = sourceUrl.startsWith(`${url}/`) ? join(root, sourceUrl.slice(url.length + 1)) : null;
        const source = local ?? sourceUrl;
        const branch = q.get("branch");
        await run("git", ["clone", "--bare", "-q", ...(branch ? ["-b", branch] : []), source, dirFor(name)]);
        return json(200, { ok: true });
      }
      case "POST /delete": {
        if (!exists) return json(200, { deleted: false });
        rmSync(dirFor(name), { recursive: true, force: true });
        return json(200, { deleted: true });
      }
      case "GET /info": {
        if (!exists) return error(404, "NOT_FOUND");
        const head = (await git(name, "symbolic-ref", "HEAD")).stdout.trim();
        return json(200, { defaultBranch: head.replace(/^refs\/heads\//, "") });
      }
      case "POST /token": {
        if (!exists) return error(404, "NOT_FOUND");
        const scope = q.get("scope") === "read" ? "read" : "write";
        const secret = `art_v1_${hex(20)}`;
        const expires = Math.floor(Date.now() / 1000) + Number(q.get("ttl") ?? 86400);
        tokens.set(secret, { repo: name, scope });
        reposWithTokens.add(name);
        return json(200, {
          id: hex(8),
          plaintext: `${secret}?expires=${expires}`,
          scope,
          expiresAt: new Date(expires * 1000).toISOString(),
        });
      }
      case "GET /read": {
        if (!exists) return error(404, "NOT_FOUND");
        const spec = `${q.get("ref")}:${q.get("path")}`;
        const type = await git(name, "cat-file", "-t", spec).catch(() => null);
        if (type?.stdout.trim() !== "blob") return error(404, "NOT_FOUND");
        const { stdout } = await run("git", ["--git-dir", dirFor(name), "cat-file", "blob", spec], {
          encoding: "buffer",
        });
        res.writeHead(200, { "content-type": contentType(q.get("path")!) });
        return res.end(stdout);
      }
      case "GET /log": {
        if (!exists) return error(404, "NOT_FOUND");
        const format = "%H%x00%T%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%at%x00%ct%x00%B%x1e";
        const args = ["log", "--first-parent", `--format=${format}`, `--max-count=${q.get("limit") ?? 50}`];
        const out = await git(
          name,
          ...args,
          `--skip=${q.get("offset") ?? 0}`,
          q.get("ref") ?? "HEAD",
          "--",
        ).catch(() => null);
        if (!out) return json(200, []);
        const commits = out.stdout
          .split("\x1e")
          .map((record) => record.replace(/^\n/, ""))
          .filter(Boolean)
          .map((record) => {
            const [hash, treeHash, parents, an, ae, cn, ce, at, ct, message] = record.split("\x00");
            return {
              hash,
              treeHash,
              parents: parents ? parents.split(" ") : [],
              author: { name: an, email: ae },
              committer: { name: cn, email: ce },
              authoredAt: Number(at),
              committedAt: Number(ct),
              // Artifacts strips one trailing newline.
              message: message!.replace(/\n$/, ""),
            };
          });
        return json(200, commits);
      }
      default:
        return error(404, "NOT_FOUND");
    }
  }

  const server = createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    if (parsed.pathname.startsWith("/_artifacts/")) {
      control(req, res, parsed.pathname.slice("/_artifacts".length), parsed.searchParams).catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "INTERNAL_ERROR", message: String(err) }));
      });
      return;
    }
    repos.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Don't keep the test process alive just for this server.
  server.unref();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    createRepo,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Not Buffer#toString("hex"): with the Workers types loaded, Buffer is typed as a plain Uint8Array.
function hex(bytes: number): string {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".txt": "text/plain",
    ".json": "application/json",
    ".md": "text/markdown",
  };
  return types[extname(path)] ?? "application/octet-stream";
}
