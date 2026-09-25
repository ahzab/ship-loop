import type { Config } from "./config.js";
import type { Git } from "./git.js";
import type { GitHubApi } from "./github.js";
import type { GateResult, Phase, RiskReport, RunState, Runner, Ticket } from "./types.js";
import { StateStore, reached } from "./state.js";
import { agentPrompt, branchName, ticketFromIssue } from "./ticket.js";
import { allPassed, runGates } from "./gates.js";
import { assessRisk } from "./risk.js";
import { prBody, prTitle } from "./pr.js";
import { checkPreview } from "./verify.js";
import { mergeVerdict } from "./merge.js";
import { tail } from "./exec.js";

export interface Deps {
  run: Runner;
  git: Pick<Git, "ensureWorktree" | "commitAll" | "diff" | "headSha" | "push">;
  gh: GitHubApi;
  config: Config;
  store: StateStore;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  pollMs?: number;
}

/** Thrown to end a run and hand it to a person. Carries the phase to retry from. */
class NeedsHuman extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function drive(issue: number, deps: Deps, opts: { retry?: boolean } = {}): Promise<RunState> {
  const { run, git, gh, config, store } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 15_000;

  const raw = await gh.getIssue(issue);
  if (raw.pull_request) throw new Error(`#${issue} is a pull request, not an issue`);
  const ticket: Ticket = ticketFromIssue(raw);

  let state: RunState = store.get(issue) ?? {
    issue,
    phase: "planned",
    branch: branchName(config.branchPrefix, ticket),
    updatedAt: new Date().toISOString(),
  };

  if (state.phase === "merged") {
    log(`#${issue} is already merged (${state.prUrl ?? "no PR recorded"})`);
    return state;
  }
  if (state.phase === "needs-human") {
    if (!opts.retry) {
      log(`#${issue} is waiting for a person: ${state.reason}. Fix it, then run again with --retry.`);
      return state;
    }
    log(`retrying #${issue} after ${state.stoppedAfter}`);
    // A person has stepped in, so the fix loop gets its full budget again.
    state = { ...state, phase: state.stoppedAfter ?? "planned", reason: undefined, stoppedAfter: undefined, rounds: 0 };
  }
  if (raw.state !== "open" && !reached(state.phase, "pr-open")) throw new Error(`#${issue} is ${raw.state}`);

  const advance = (phase: Phase, patch: Partial<RunState> = {}, note?: string) => {
    state = store.save({ ...state, ...patch, phase });
    log(`✓ ${phase}${note ? ` (${note})` : ""}`);
  };

  try {
    // Re-binding is idempotent, so a resumed run always works in the same checkout.
    const wt = await git.ensureWorktree(state.branch, config.baseBranch, config.copyIntoWorktree);
    if (!reached(state.phase, "worktree")) {
      if (config.install) {
        log(`installing: ${config.install.join(" ")}`);
        const r = await run(config.install, { cwd: wt });
        if (r.code !== 0) throw new NeedsHuman(`install failed:\n${tail(r, 30)}`);
      }
      advance("worktree", { worktree: wt });
    }

    const runAgent = async (failures?: GateResult[]) => {
      log(failures ? `agent: fixing ${failures.map((f) => f.name).join(", ")}` : "agent: working on the issue");
      const prompt = agentPrompt(ticket, failures?.map((f) => ({ name: f.name, output: f.output })));
      const r = await run(config.agent.command, { cwd: wt, input: prompt });
      if (r.code !== 0) throw new NeedsHuman(`agent exited ${r.code}:\n${tail(r, 30)}`);
      return git.commitAll(wt, prTitle(ticket));
    };

    if (!reached(state.phase, "built")) {
      const changed = await runAgent();
      if (!changed && (await git.diff(wt, config.baseBranch)).length === 0) {
        throw new NeedsHuman("the agent made no changes");
      }
      advance("built", { rounds: 0 });
    }

    if (!reached(state.phase, "gated")) {
      let rounds = state.rounds ?? 0;
      let gates = await runGates(run, wt, config.gates);
      while (!allPassed(gates)) {
        const failing = gates.filter((g) => !g.ok);
        if (rounds >= config.agent.maxFixRounds) {
          state = { ...state, gates, rounds };
          throw new NeedsHuman(`still failing after ${rounds} fix round(s): ${failing.map((g) => g.name).join(", ")}`);
        }
        rounds++;
        await runAgent(failing);
        gates = await runGates(run, wt, config.gates);
      }
      advance("gated", { gates, rounds });
    }

    const risk: RiskReport = assessRisk(await git.diff(wt, config.baseBranch), config.risk);
    state = { ...state, risk };
    log(`risk: ${risk.level}${risk.factors.length ? ` (${risk.factors.map((f) => f.reason).join("; ")})` : ""}`);

    if (!reached(state.phase, "pushed")) {
      await git.push(wt, state.branch);
      advance("pushed");
    }

    if (!reached(state.phase, "pr-open")) {
      const body = prBody(ticket, state.gates ?? [], risk, state.rounds ?? 0);
      let pr = await gh.findOpenPr(state.branch);
      if (pr) await gh.updatePrBody(pr.number, body);
      else pr = await gh.createPr({ title: prTitle(ticket), body, head: state.branch, base: config.baseBranch });
      if (risk.level === "high") await gh.addLabel(pr.number, "needs-review");
      advance("pr-open", { pr: pr.number, prUrl: pr.url });
    }
    const prNumber = state.pr!;

    if (!reached(state.phase, "preview-verified")) {
      if (!config.preview.enabled) {
        advance("preview-verified", { previewStatus: "skipped" }, "skipped: preview.enabled is false");
      } else {
        const sha = await git.headSha(wt);
        const deadline = now() + config.preview.timeoutSec * 1000;
        let url: string | null = null;
        while (!(url = await gh.previewUrl(sha))) {
          if (now() >= deadline) throw new NeedsHuman(`no preview deployment reported for ${sha.slice(0, 7)} within ${config.preview.timeoutSec}s`);
          await sleep(pollMs);
        }
        const check = await checkPreview(url, config.preview.path, deps.fetchImpl);
        if (!check.ok && check.kind !== "protected") throw new NeedsHuman(`preview ${check.url} ${check.detail}`);
        const status = check.ok ? "verified" : "protected";
        await gh.comment(
          prNumber,
          check.ok
            ? `Preview verified: ${check.url} answered HTTP ${check.status}.`
            : `Preview deployed at ${url}, but ${check.detail}. The page itself has not been checked.`,
        );
        advance("preview-verified", { previewUrl: url, previewStatus: status });
      }
    }

    if (!config.merge.auto) {
      log(`ready for review: ${state.prUrl}`);
      return state;
    }
    if (state.previewStatus === "protected") {
      throw new NeedsHuman("the preview is behind a login wall, so nothing has checked the page: a person merges this");
    }

    const deadline = now() + config.merge.timeoutSec * 1000;
    for (;;) {
      const pr = await gh.getPr(prNumber);
      const verdict = mergeVerdict(pr, await gh.getChecks(pr.headSha), risk.level, config.merge, config.baseBranch);
      if (verdict.decision === "merge") {
        await gh.merge(prNumber, pr.headSha, config.merge.method);
        advance("merged");
        return state;
      }
      if (verdict.decision === "refuse") {
        await gh.comment(prNumber, `Not merging automatically: ${verdict.reason}.`);
        throw new NeedsHuman(verdict.reason);
      }
      if (now() >= deadline) throw new NeedsHuman(`timed out after ${config.merge.timeoutSec}s: ${verdict.reason}`);
      log(verdict.reason);
      await sleep(pollMs);
    }
  } catch (e) {
    if (!(e instanceof NeedsHuman)) throw e;
    state = store.save({ ...state, phase: "needs-human", reason: e.reason, stoppedAfter: state.phase });
    log(`✗ needs a person: ${e.reason}`);
    return state;
  }
}

