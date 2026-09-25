/** A unit of work, read from a GitHub issue. */
export interface Ticket {
  number: number;
  title: string;
  body: string;
  /** Checkbox lines from the issue body: the definition of done. */
  acceptance: string[];
  url: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything that shells out goes through this, so tests can replace it. */
export type Runner = (cmd: string[], opts: { cwd: string; input?: string; env?: Record<string, string> }) => Promise<ExecResult>;

export type RiskLevel = "low" | "medium" | "high";

export interface RiskFactor {
  level: RiskLevel;
  reason: string;
  files: string[];
}

export interface RiskReport {
  level: RiskLevel;
  factors: RiskFactor[];
  stats: { files: number; added: number; removed: number };
}

export interface GateResult {
  name: string;
  command: string[];
  ok: boolean;
  /** Tail of the output, enough to hand back to the agent on failure. */
  output: string;
  ms: number;
}

export type CheckState = "success" | "failure" | "pending" | "neutral" | "skipped";

export interface Check {
  name: string;
  state: CheckState;
  url?: string;
}

export interface PullRequest {
  number: number;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
}

/**
 * Phases a run moves through, in order. The state file records the last one
 * completed, and `resume` continues from the next. `needs-human` and `merged`
 * are terminal.
 */
export const PHASES = ["planned", "worktree", "built", "gated", "pushed", "pr-open", "preview-verified", "merged"] as const;
export type Phase = (typeof PHASES)[number] | "needs-human";

export interface RunState {
  issue: number;
  phase: Phase;
  branch: string;
  worktree?: string;
  pr?: number;
  prUrl?: string;
  previewUrl?: string;
  risk?: RiskReport;
  gates?: GateResult[];
  rounds?: number;
  /** Why the run stopped for a person, when it did. */
  reason?: string;
  /** The last phase completed before stopping for a person: where `--retry` picks up. */
  stoppedAfter?: Phase;
  /** How the preview answered: verified content, or deployed behind a login wall. */
  previewStatus?: "verified" | "protected" | "skipped";
  updatedAt: string;
}
