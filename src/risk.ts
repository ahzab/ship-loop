import type { Config } from "./config.js";
import type { DiffEntry } from "./git.js";
import type { RiskFactor, RiskLevel, RiskReport } from "./types.js";

/** Glob to RegExp: `**` spans directories, `*` stays within one segment. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more whole directories
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
      else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

const TEST_FILE = /(^|\/)(__tests__|tests?|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|swift|php|vue|svelte)$/;

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * Score a diff by what it touches, not by how clever the change looks. The
 * point is to decide who has to look at it: a low-risk change can merge on
 * green CI, anything touching data, auth, CI itself or dependencies waits for
 * a person. Every factor names the files that raised it, so the PR says why.
 */
export function assessRisk(diff: DiffEntry[], rules: Config["risk"]): RiskReport {
  const factors: RiskFactor[] = [];
  const add = (level: RiskLevel, reason: string, files: string[]) => {
    if (files.length) factors.push({ level, reason, files });
  };
  const matching = (globs: string[]) => {
    const res = globs.map(globToRegExp);
    return diff.filter((d) => res.some((r) => r.test(d.path))).map((d) => d.path);
  };

  const high = matching(rules.high);
  add("high", "touches schema, auth, access control or CI configuration", high);
  add("medium", "changes dependencies, environment or deploy configuration", matching(rules.medium).filter((f) => !high.includes(f)));
  add("medium", "deletes files", diff.filter((d) => d.status === "deleted").map((d) => d.path));

  const lines = diff.reduce((n, d) => n + d.added + d.removed, 0);
  if (lines > rules.maxLines * 2) add("high", `large diff: ${lines} changed lines`, ["(whole diff)"]);
  else if (lines > rules.maxLines) add("medium", `large diff: ${lines} changed lines`, ["(whole diff)"]);

  const source = diff.filter((d) => SOURCE_FILE.test(d.path) && !TEST_FILE.test(d.path) && d.status !== "deleted");
  const tests = diff.filter((d) => TEST_FILE.test(d.path));
  if (source.length && !tests.length) add("medium", "changes source code without changing any test", source.map((d) => d.path));

  const level = factors.reduce<RiskLevel>((max, f) => (RANK[f.level] > RANK[max] ? f.level : max), "low");
  return {
    level,
    factors,
    stats: {
      files: diff.length,
      added: diff.reduce((n, d) => n + d.added, 0),
      removed: diff.reduce((n, d) => n + d.removed, 0),
    },
  };
}

export function riskAtMost(level: RiskLevel, max: RiskLevel): boolean {
  return RANK[level] <= RANK[max];
}
