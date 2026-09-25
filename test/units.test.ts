import { describe, expect, it } from "vitest";
import { acceptanceCriteria, agentPrompt, branchName, ticketFromIssue } from "../src/ticket.js";
import { assessRisk, globToRegExp } from "../src/risk.js";
import { mergeVerdict } from "../src/merge.js";
import { checkPreview } from "../src/verify.js";
import { DEFAULTS, validate, type Config } from "../src/config.js";
import type { DiffEntry } from "../src/git.js";
import type { Check, PullRequest } from "../src/types.js";

describe("ticket", () => {
  it("reads checkbox lines as acceptance criteria, checked or not", () => {
    const body = "Intro\n\n- [ ] Export as CSV\n* [x] Keeps column order  \n- not a box\n  - [ ] Nested works too";
    expect(acceptanceCriteria(body)).toEqual(["Export as CSV", "Keeps column order", "Nested works too"]);
  });

  it("makes short, git-safe branch names", () => {
    expect(branchName("ship/", { number: 42, title: "Add CSV export (orders page)!" })).toBe("ship/42-add-csv-export-orders-page");
    expect(branchName("ship/", { number: 7, title: "Résumé über café" })).toBe("ship/7-resume-uber-cafe");
    expect(branchName("ship/", { number: 9, title: "!!!" })).toBe("ship/9");
    expect(branchName("s/", { number: 1, title: "a".repeat(80) }).length).toBeLessThanOrEqual(2 + 1 + 1 + 40);
  });

  it("puts the definition of done and any gate failures in the agent brief", () => {
    const t = ticketFromIssue({ number: 3, title: "Fix totals", body: "- [ ] totals include tax", html_url: "u" });
    const p = agentPrompt(t, [{ name: "test", output: "expected 110, got 100" }]);
    expect(p).toContain("- totals include tax");
    expect(p).toContain("Do not commit, push, merge");
    expect(p).toContain("## test");
    expect(p).toContain("expected 110, got 100");
  });
});

const d = (path: string, added = 5, removed = 0, status: DiffEntry["status"] = "modified"): DiffEntry => ({ path, added, removed, status });

describe("risk", () => {
  it("matches globs across and within path segments", () => {
    expect(globToRegExp("**/migrations/**").test("supabase/migrations/001.sql")).toBe(true);
    expect(globToRegExp("**/migrations/**").test("migrations/001.sql")).toBe(true);
    expect(globToRegExp("**/*auth*.*").test("src/lib/authClient.ts")).toBe(true);
    expect(globToRegExp("package.json").test("apps/web/package.json")).toBe(false);
    expect(globToRegExp("**/.env*").test(".env.local")).toBe(true);
  });

  it("is low for a small change that carries its own test", () => {
    const r = assessRisk([d("src/format.ts"), d("src/format.test.ts")], DEFAULTS.risk);
    expect(r.level).toBe("low");
    expect(r.factors).toEqual([]);
  });

  it("is high when the diff touches migrations or CI, and names the files", () => {
    const r = assessRisk([d("supabase/migrations/002.sql"), d(".github/workflows/ci.yml"), d("src/a.test.ts")], DEFAULTS.risk);
    expect(r.level).toBe("high");
    expect(r.factors[0]!.files).toEqual(["supabase/migrations/002.sql", ".github/workflows/ci.yml"]);
  });

  it("is medium for dependency changes, deletions, or source without tests", () => {
    expect(assessRisk([d("package.json"), d("src/a.test.ts")], DEFAULTS.risk).level).toBe("medium");
    expect(assessRisk([d("src/old.ts", 0, 40, "deleted")], DEFAULTS.risk).level).toBe("medium");
    const untested = assessRisk([d("src/a.ts")], DEFAULTS.risk);
    expect(untested.level).toBe("medium");
    expect(untested.factors[0]!.reason).toMatch(/without changing any test/);
  });

  it("grades size: medium past maxLines, high past twice that", () => {
    const withTest = (n: number) => [d("src/a.ts", n), d("src/a.test.ts", 1)];
    expect(assessRisk(withTest(300), DEFAULTS.risk).level).toBe("low");
    expect(assessRisk(withTest(500), DEFAULTS.risk).level).toBe("medium");
    expect(assessRisk(withTest(900), DEFAULTS.risk).level).toBe("high");
  });
});

describe("merge gate", () => {
  const pr: PullRequest = { number: 5, url: "u", headSha: "abc", headRef: "ship/5", baseRef: "main", draft: false, state: "open", merged: false };
  const on: Config["merge"] = { ...DEFAULTS.merge, auto: true, requiredCheck: "ci" };
  const green: Check[] = [{ name: "ci", state: "success" }, { name: "Vercel", state: "success" }];
  const v = (p: Partial<PullRequest>, checks: Check[], risk: "low" | "medium" | "high" = "low", m = on) =>
    mergeVerdict({ ...pr, ...p }, checks, risk, m, "main");

  it("merges only when the required check is green and nothing failed", () => {
    expect(v({}, green).decision).toBe("merge");
  });

  it("refuses when auto-merge is off, the PR is a draft, or targets another branch", () => {
    expect(v({}, green, "low", { ...on, auto: false }).decision).toBe("refuse");
    expect(v({ draft: true }, green).decision).toBe("refuse");
    expect(v({ baseRef: "release" }, green).decision).toBe("refuse");
  });

  it("refuses a green PR whose only checks are the host's deploy statuses", () => {
    const r = v({}, [{ name: "Vercel", state: "success" }]);
    expect(r).toEqual({ decision: "refuse", reason: 'required check "ci" never ran on this commit' });
  });

  it("refuses with no checks at all, since green would be vacuous", () => {
    expect(v({}, []).decision).toBe("refuse");
  });

  it("refuses on any failure and on risk above the limit", () => {
    expect(v({}, [...green, { name: "lint", state: "failure" }]).decision).toBe("refuse");
    expect(v({}, green, "medium").decision).toBe("refuse");
    expect(v({}, green, "medium", { ...on, maxRisk: "medium" }).decision).toBe("merge");
  });

  it("waits while checks are still running", () => {
    expect(v({}, [{ name: "ci", state: "pending" }]).decision).toBe("wait");
    expect(v({}, [{ name: "Vercel", state: "pending" }]).decision).toBe("wait");
  });
});

describe("preview check", () => {
  const fake = (routes: Record<string, { status: number; location?: string }>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const r = routes[String(input)];
      if (!r) throw new Error("ECONNREFUSED");
      return new Response(null, { status: r.status, headers: r.location ? { location: r.location } : {} });
    }) as typeof fetch;

  it("passes a page that answers 2xx, following redirects", async () => {
    const f = fake({ "https://p.app/": { status: 307, location: "/en" }, "https://p.app/en": { status: 200 } });
    expect(await checkPreview("https://p.app", "/", f)).toMatchObject({ ok: true, status: 200 });
  });

  it("reports a login wall as protected, not as a pass", async () => {
    const f = fake({ "https://p.app/": { status: 302, location: "https://vercel.com/sso-api?url=x" } });
    expect(await checkPreview("https://p.app", "/", f)).toMatchObject({ ok: false, kind: "protected" });
  });

  it("reports server errors and unreachable hosts", async () => {
    expect(await checkPreview("https://p.app", "/api/health", fake({ "https://p.app/api/health": { status: 503 } }))).toMatchObject({ ok: false, kind: "http", status: 503 });
    expect(await checkPreview("https://gone.app", "/", fake({}))).toMatchObject({ ok: false, kind: "unreachable" });
  });
});

describe("config", () => {
  it("accepts the defaults", () => {
    expect(validate(DEFAULTS)).toEqual([]);
  });

  it("refuses auto-merge without a named required check, and high as a merge ceiling", () => {
    const errors = validate({ ...DEFAULTS, merge: { ...DEFAULTS.merge, auto: true, maxRisk: "high" as "low" } });
    expect(errors.join("\n")).toMatch(/requiredCheck/);
    expect(errors.join("\n")).toMatch(/maxRisk/);
  });
});
