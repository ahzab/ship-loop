import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, GitError } from "../src/git.js";
import { run } from "../src/exec.js";

let tmp: string;
let clone: string;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A real origin, a real clone parked on an unrelated branch with uncommitted
// junk: the situation a worktree has to be immune to.
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ship-loop-git-"));
  const origin = join(tmp, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  clone = join(tmp, "app");
  execFileSync("git", ["clone", "-q", origin, clone], { stdio: "ignore" });
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"]]) sh(clone, "config", k!, v!);
  writeFileSync(join(clone, "a.txt"), "one\n");
  sh(clone, "add", ".");
  sh(clone, "commit", "-qm", "init");
  sh(clone, "push", "-q", "origin", "main");
  sh(clone, "checkout", "-qb", "old-feature");
  writeFileSync(join(clone, "a.txt"), "half-written\n");
  writeFileSync(join(clone, ".env"), "SECRET=1\n");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("worktrees", () => {
  it("cuts the branch from origin/main and leaves the primary clone alone", async () => {
    const git = new Git(run, clone);
    const wt = await git.ensureWorktree("ship/1-x", "main", [".env"]);

    expect(sh(wt, "branch", "--show-current")).toBe("ship/1-x");
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(sh(clone, "branch", "--show-current")).toBe("old-feature");
    expect(readFileSync(join(clone, "a.txt"), "utf8")).toBe("half-written\n");
    expect(wt.startsWith(clone)).toBe(false);
  });

  it("is idempotent, so a resumed run gets the same checkout", async () => {
    const git = new Git(run, clone);
    const a = await git.ensureWorktree("ship/2-y", "main", []);
    writeFileSync(join(a, "b.txt"), "work in progress\n");
    const b = await git.ensureWorktree("ship/2-y", "main", []);
    expect(b).toBe(a);
    expect(existsSync(join(b, "b.txt"))).toBe(true);
  });

  it("refuses a branch already checked out somewhere else", async () => {
    const git = new Git(run, clone);
    await expect(git.ensureWorktree("old-feature", "main", [])).rejects.toThrow(GitError);
  });

  it("commits the agent's changes and reports the diff against the base", async () => {
    const git = new Git(run, clone);
    const wt = await git.ensureWorktree("ship/3-z", "main", []);
    for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"]]) sh(wt, "config", k!, v!);
    expect(await git.commitAll(wt, "nothing")).toBe(false);

    writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
    writeFileSync(join(wt, "new.test.ts"), "x\ny\n");
    expect(await git.commitAll(wt, "Add two (#3)")).toBe(true);
    expect(sh(wt, "log", "-1", "--format=%s")).toBe("Add two (#3)");

    const diff = await git.diff(wt, "main");
    expect(diff).toEqual(
      expect.arrayContaining([
        { path: "a.txt", added: 1, removed: 0, status: "modified" },
        { path: "new.test.ts", added: 2, removed: 0, status: "added" },
      ]),
    );
  });

  it("keeps run state in the shared .git dir, outside every working tree", async () => {
    const git = new Git(run, clone);
    expect(await git.stateDir()).toBe(join(clone, ".git", "ship-loop"));
  });
});
