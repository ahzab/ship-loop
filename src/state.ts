import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PHASES, type Phase, type RunState } from "./types.js";

/**
 * One JSON file per issue under .git/ship-loop: shared by every worktree,
 * never committed, and written atomically so a run killed mid-write cannot
 * leave a half-file that `resume` then misreads.
 */
export class StateStore {
  constructor(private readonly dir: string) {}

  private file(issue: number) {
    return join(this.dir, `${issue}.json`);
  }

  get(issue: number): RunState | null {
    const f = this.file(issue);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as RunState) : null;
  }

  save(state: RunState): RunState {
    mkdirSync(this.dir, { recursive: true });
    const next = { ...state, updatedAt: new Date().toISOString() };
    const tmp = `${this.file(state.issue)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.file(state.issue));
    return next;
  }

  list(): RunState[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as RunState)
      .sort((a, b) => a.issue - b.issue);
  }
}

/** True when `phase` is at or past `target` in the run's order. */
export function reached(phase: Phase, target: (typeof PHASES)[number]): boolean {
  if (phase === "needs-human") return false;
  return PHASES.indexOf(phase) >= PHASES.indexOf(target);
}

export const isTerminal = (p: Phase) => p === "merged" || p === "needs-human";
