import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Runner } from "./types.js";
import { tail } from "./exec.js";

export class GitError extends Error {}

export interface DiffEntry {
  path: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export class Git {
  constructor(private readonly run: Runner, readonly root: string) {}

  private async git(args: string[], cwd = this.root): Promise<string> {
    const r = await this.run(["git", ...args], { cwd });
    if (r.code !== 0) throw new GitError(`git ${args.join(" ")} failed:\n${tail(r, 20)}`);
    return r.stdout;
  }

  /** owner/name from the origin remote (https or ssh form). */
  async remoteRepo(): Promise<string> {
    const url = (await this.git(["remote", "get-url", "origin"])).trim();
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (!m) throw new GitError(`origin is not a GitHub remote: ${url}`);
    return `${m[1]}/${m[2]}`;
  }

  /** The shared .git dir, so run state is visible from every worktree and never committed. */
  async stateDir(): Promise<string> {
    const common = (await this.git(["rev-parse", "--git-common-dir"])).trim();
    return join(resolve(this.root, common), "ship-loop");
  }

  /** Worktrees live beside the repo, not inside it, so tools that walk the repo never see them. */
  worktreePath(branch: string): string {
    return join(dirname(this.root), ".ship-loop", basename(this.root), branch.replace(/\//g, "-"));
  }

  private async worktrees(): Promise<Map<string, string>> {
    const out = await this.git(["worktree", "list", "--porcelain"]);
    const byBranch = new Map<string, string>();
    let path = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch refs/heads/")) byBranch.set(line.slice(18), path);
    }
    return byBranch;
  }

  /**
   * A private checkout for one issue, cut from a freshly fetched base branch.
   * Idempotent: a resumed run gets the same worktree back. Refuses when the
   * branch is already checked out somewhere else, because two sessions editing
   * one branch is the failure this exists to prevent.
   */
  async ensureWorktree(branch: string, base: string, copy: string[]): Promise<string> {
    const path = this.worktreePath(branch);
    const existing = (await this.worktrees()).get(branch);
    if (existing) {
      // git prints resolved paths (/private/var on macOS), so compare real paths.
      const same = existsSync(path) && realpathSync(existing) === realpathSync(path);
      if (same) return path;
      throw new GitError(`branch ${branch} is already checked out at ${existing}: finish or remove that checkout first`);
    }
    if (existsSync(path)) throw new GitError(`${path} exists but is not a registered worktree: remove it or run \`git worktree prune\``);

    await this.git(["fetch", "--quiet", "origin", base]);
    mkdirSync(dirname(path), { recursive: true });
    const branchExists = (await this.run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.root })).code === 0;
    if (branchExists) await this.git(["worktree", "add", path, branch]);
    else await this.git(["worktree", "add", "-b", branch, path, `origin/${base}`]);

    for (const name of copy) {
      const src = join(this.root, name);
      if (existsSync(src) && !existsSync(join(path, name))) cpSync(src, join(path, name), { recursive: true });
    }
    return path;
  }

  async isDirty(cwd: string): Promise<boolean> {
    return (await this.git(["status", "--porcelain"], cwd)).trim().length > 0;
  }

  /** Stage and commit everything the agent changed. Returns false when there was nothing to commit. */
  async commitAll(cwd: string, message: string): Promise<boolean> {
    if (!(await this.isDirty(cwd))) return false;
    await this.git(["add", "-A"], cwd);
    await this.git(["commit", "--quiet", "-m", message], cwd);
    return true;
  }

  /** What this branch changes relative to the base, including renames and deletions. */
  async diff(cwd: string, base: string): Promise<DiffEntry[]> {
    const range = `origin/${base}...HEAD`;
    const numstat = await this.git(["diff", "--numstat", "-M", range], cwd);
    const nameStatus = await this.git(["diff", "--name-status", "-M", range], cwd);
    const status = new Map<string, DiffEntry["status"]>();
    for (const line of nameStatus.split("\n").filter(Boolean)) {
      const [code, ...paths] = line.split("\t");
      const p = paths[paths.length - 1] ?? "";
      status.set(p, code?.startsWith("A") ? "added" : code?.startsWith("D") ? "deleted" : code?.startsWith("R") ? "renamed" : "modified");
    }
    return numstat
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [a, r, ...rest] = line.split("\t");
        // Renames print as `old => new` or `dir/{old => new}/file`; keep the new path.
        const raw = rest.join("\t");
        const path = raw.includes("=>") ? raw.replace(/\{[^}]*=> ([^}]*)\}/, "$1").replace(/^.* => /, "") : raw;
        return {
          path,
          added: a === "-" ? 0 : Number(a),
          removed: r === "-" ? 0 : Number(r),
          status: status.get(path) ?? "modified",
        };
      });
  }

  async headSha(cwd: string): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"], cwd)).trim();
  }

  async push(cwd: string, branch: string): Promise<void> {
    await this.git(["push", "--quiet", "-u", "origin", branch], cwd);
  }
}
