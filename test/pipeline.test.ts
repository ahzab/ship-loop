import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drive, type Deps } from "../src/pipeline.js";
import { DEFAULTS, type Config } from "../src/config.js";
import { StateStore } from "../src/state.js";
import type { GitHubApi } from "../src/github.js";
import type { DiffEntry } from "../src/git.js";
import type { Check, ExecResult, PullRequest } from "../src/types.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stdout: string): ExecResult => ({ code: 1, stdout, stderr: "" });

/** A scripted world: the agent's edits, each gate's results, and a GitHub that records what was done to it. */
function world(opts: { gateResults?: ExecResult[][]; diff?: DiffEntry[]; checks?: Check[][]; preview?: (string | null)[]; merge?: Partial<Config["merge"]> } = {}) {
  const calls: string[] = [];
  const gateQueue = [...(opts.gateResults ?? [[ok(), ok()]])];
  let currentRound: ExecResult[] = [];
  let dirty = false;
  const diff = opts.diff ?? [
    { path: "src/export.ts", added: 30, removed: 2, status: "modified" as const },
    { path: "src/export.test.ts", added: 25, removed: 0, status: "added" as const },
  ];
  const checksQueue = [...(opts.checks ?? [[{ name: "ci", state: "success" as const }]])];
  const previewQueue = [...(opts.preview ?? ["https://preview.example.app"])];
  let pr: PullRequest | null = null;

  const run: Deps["run"] = async (cmd, o) => {
    const c = cmd.join(" ");
    if (cmd[0] === "claude") {
      calls.push(o.input?.includes("previous attempt failed") ? "agent:fix" : "agent");
      dirty = true;
      return ok();
    }
    if (c === "npm ci") { calls.push("install"); return ok(); }
    if (c === "npm test") { currentRound = gateQueue.shift() ?? [ok(), ok()]; calls.push("gate:test"); return currentRound[0]!; }
    if (c === "npm run build") { calls.push("gate:build"); return currentRound[1] ?? ok(); }
    throw new Error(`unexpected command ${c}`);
  };

  const git: Deps["git"] = {
    ensureWorktree: async () => { calls.push("worktree"); return "/wt"; },
    commitAll: async () => { const was = dirty; dirty = false; if (was) calls.push("commit"); return was; },
    diff: async () => diff,
    headSha: async () => "sha1",
    push: async () => { calls.push("push"); },
  };

  const gh: GitHubApi = {
    getIssue: async (n) => ({ number: n, title: "Add CSV export", body: "- [ ] exports every row", html_url: `https://gh/i/${n}`, state: "open" }),
    findOpenPr: async () => pr,
    getPr: async () => pr!,
    createPr: async (p) => { calls.push("pr:create"); pr = { number: 9, url: "https://gh/pr/9", headSha: "sha1", headRef: p.head, baseRef: p.base, draft: false, state: "open", merged: false }; return pr; },
    updatePrBody: async () => { calls.push("pr:update"); },
    addLabel: async (_n, l) => { calls.push(`label:${l}`); },
    comment: async (_n, b) => { calls.push(`comment:${b.slice(0, 30)}`); },
    getChecks: async () => checksQueue.shift() ?? [{ name: "ci", state: "success" }],
    previewUrl: async () => (previewQueue.length ? previewQueue.shift()! : "https://preview.example.app"),
    merge: async () => { calls.push("merge"); },
  };

  const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  const config: Config = { ...DEFAULTS, merge: { ...DEFAULTS.merge, ...opts.merge } };
  return { calls, run, git, gh, fetchImpl, config };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ship-loop-state-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(w: ReturnType<typeof world>): Deps {
  return { run: w.run, git: w.git, gh: w.gh, config: w.config, store: new StateStore(dir), fetchImpl: w.fetchImpl, sleep: async () => {}, pollMs: 0 };
}

describe("drive", () => {
  it("takes an issue to a verified preview and stops for review when auto-merge is off", async () => {
    const w = world();
    const s = await drive(12, deps(w));
    expect(s.phase).toBe("preview-verified");
    expect(s.previewStatus).toBe("verified");
    expect(s.risk?.level).toBe("low");
    expect(w.calls).toEqual(["worktree", "install", "agent", "commit", "gate:test", "gate:build", "push", "pr:create", "comment:Preview verified: https://prev"]);
  });

  it("hands failing gates back to the agent and continues once they pass", async () => {
    const w = world({ gateResults: [[fail("1 failed: totals"), ok()], [ok(), ok()]] });
    const s = await drive(12, deps(w));
    expect(s.phase).toBe("preview-verified");
    expect(s.rounds).toBe(1);
    expect(w.calls.slice(2, 10)).toEqual(["agent", "commit", "gate:test", "gate:build", "agent:fix", "commit", "gate:test", "gate:build"]);
  });

  it("stops for a person after the fix budget, and --retry picks up with a fresh budget", async () => {
    const red = [fail("still red"), ok()];
    const w = world({ gateResults: [red, red, red, red, [ok(), ok()]] });
    const d = deps(w);
    const stopped = await drive(12, d);
    expect(stopped).toMatchObject({ phase: "needs-human", stoppedAfter: "built", rounds: 3 });
    expect(stopped.reason).toMatch(/still failing after 3 fix round\(s\): test/);
    expect(w.calls).not.toContain("push");

    expect((await drive(12, d)).phase).toBe("needs-human"); // without --retry, nothing runs
    const retried = await drive(12, d, { retry: true });
    expect(retried.phase).toBe("preview-verified");
    expect(w.calls.filter((c) => c === "agent")).toHaveLength(1); // the first build is not redone
  });

  it("resumes after a crash without pushing or opening the PR twice", async () => {
    const w = world();
    const d = deps(w);
    await drive(12, d);
    const pushes = w.calls.filter((c) => c === "push").length;
    const s = await drive(12, d);
    expect(s.phase).toBe("preview-verified");
    expect(w.calls.filter((c) => c === "push").length).toBe(pushes);
    expect(w.calls.filter((c) => c === "pr:create")).toHaveLength(1);
  });

  it("labels a high-risk PR and never merges it, even with auto-merge on", async () => {
    const w = world({
      diff: [{ path: "supabase/migrations/003_orders.sql", added: 12, removed: 0, status: "added" }, { path: "src/a.test.ts", added: 3, removed: 0, status: "added" }],
      merge: { auto: true, requiredCheck: "ci" },
    });
    const s = await drive(12, deps(w));
    expect(w.calls).toContain("label:needs-review");
    expect(w.calls).not.toContain("merge");
    expect(s).toMatchObject({ phase: "needs-human", stoppedAfter: "preview-verified" });
    expect(s.reason).toMatch(/risk is high/);
  });

  it("waits for checks, then merges when the required check is green", async () => {
    const w = world({
      merge: { auto: true, requiredCheck: "ci" },
      checks: [[{ name: "ci", state: "pending" }], [{ name: "ci", state: "success" }, { name: "Vercel", state: "success" }]],
    });
    const s = await drive(12, deps(w));
    expect(s.phase).toBe("merged");
    expect(w.calls.at(-1)).toBe("merge");
  });

  it("refuses to merge when only the host's deploy status is green", async () => {
    const w = world({ merge: { auto: true, requiredCheck: "ci" }, checks: [[{ name: "Vercel", state: "success" }]] });
    const s = await drive(12, deps(w));
    expect(s.phase).toBe("needs-human");
    expect(s.reason).toMatch(/"ci" never ran/);
    expect(w.calls).not.toContain("merge");
  });

  it("does not auto-merge a preview it could only see behind a login wall", async () => {
    const w = world({ merge: { auto: true, requiredCheck: "ci" } });
    const d = deps(w);
    d.fetchImpl = (async () => new Response(null, { status: 302, headers: { location: "https://vercel.com/sso-api?x=1" } })) as typeof fetch;
    const s = await drive(12, d);
    expect(s.previewStatus).toBe("protected");
    expect(s.phase).toBe("needs-human");
    expect(w.calls).not.toContain("merge");
  });

  it("stops when no preview deployment shows up in time", async () => {
    const w = world({ preview: [null, null, null] });
    const d = deps(w);
    let t = 0;
    d.now = () => (t += 400_000);
    const s = await drive(12, d);
    expect(s).toMatchObject({ phase: "needs-human", stoppedAfter: "pr-open" });
    expect(s.reason).toMatch(/no preview deployment/);
  });

  it("stops when the agent changes nothing", async () => {
    const w = world({ diff: [] });
    const d = deps(w);
    d.run = async (cmd) => (cmd[0] === "claude" ? ok() : ok());
    const s = await drive(12, d);
    expect(s).toMatchObject({ phase: "needs-human", reason: "the agent made no changes" });
  });
});
