import type { Config } from "./config.js";
import type { Check, PullRequest, RiskLevel } from "./types.js";
import { riskAtMost } from "./risk.js";

export type MergeVerdict =
  | { decision: "merge" }
  | { decision: "wait"; reason: string }
  | { decision: "refuse"; reason: string };

/**
 * Whether a PR may merge without a person, given everything known right now.
 * `wait` means ask again later (checks still running). `refuse` is final for
 * this run: the answer is that a person merges it, not that the tool should
 * find another way through.
 *
 * The rule that matters most is the required check. "All checks passed" is
 * true of a PR with no checks, and of a PR whose only checks are a hosting
 * provider's deploy statuses: green, while nothing linted, typed or tested it.
 */
export function mergeVerdict(pr: PullRequest, checks: Check[], risk: RiskLevel, merge: Config["merge"], base: string): MergeVerdict {
  if (!merge.auto) return { decision: "refuse", reason: "auto-merge is off (merge.auto): a person merges this PR" };
  if (pr.merged) return { decision: "refuse", reason: "already merged" };
  if (pr.state !== "open") return { decision: "refuse", reason: "PR is closed" };
  if (pr.draft) return { decision: "refuse", reason: "PR is a draft" };
  if (pr.baseRef !== base) return { decision: "refuse", reason: `PR targets ${pr.baseRef}, not ${base}` };
  if (!riskAtMost(risk, merge.maxRisk)) return { decision: "refuse", reason: `diff risk is ${risk}; unattended merges allow ${merge.maxRisk} at most` };
  if (!checks.length) return { decision: "refuse", reason: "no checks ran on this commit, so green would mean nothing" };

  const failed = checks.filter((c) => c.state === "failure");
  if (failed.length) return { decision: "refuse", reason: `failed: ${failed.map((c) => c.name).join(", ")}` };

  const required = merge.requiredCheck;
  if (!required) return { decision: "refuse", reason: "no merge.requiredCheck configured" };
  const req = checks.filter((c) => c.name === required);
  const pending = checks.filter((c) => c.state === "pending");
  if (!req.length) {
    return pending.length
      ? { decision: "wait", reason: `required check "${required}" has not reported yet` }
      : { decision: "refuse", reason: `required check "${required}" never ran on this commit` };
  }
  if (pending.length) return { decision: "wait", reason: `waiting on ${pending.map((c) => c.name).join(", ")}` };
  return { decision: "merge" };
}
