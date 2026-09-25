#!/usr/bin/env node
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { run as exec } from "./exec.js";
import { Git } from "./git.js";
import { GitHub } from "./github.js";
import { drive } from "./pipeline.js";
import { assessRisk } from "./risk.js";
import { StateStore } from "./state.js";
import { agentPrompt, branchName, ticketFromIssue } from "./ticket.js";
import type { RunState } from "./types.js";

const HELP = `ship-loop <command> [options]

Take a GitHub issue to a verified preview and, when every gate allows it, a merge.

Commands
  run <issue> [--retry]   run or resume an issue. --retry continues one that stopped for a person
  plan <issue>            print the branch, gates, merge policy and the agent's brief; changes nothing
  status [issue]          show where each run is, and why any stopped
  risk [--base <branch>]  score the current branch's diff against the base, the same way run does

Run from the root of a repo whose origin is on GitHub. Needs GITHUB_TOKEN (or a
logged-in gh CLI) for run and plan. Settings: ship-loop.config.json.

Exit codes: 0 done or ready for review, 1 stopped for a person, 2 usage or setup error.`;

async function token(root: string): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = await exec(["gh", "auth", "token"], { cwd: root });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error("no GitHub token: set GITHUB_TOKEN or run `gh auth login`");
}

function printState(s: RunState): void {
  const bits = [`#${s.issue}`, s.phase, s.branch];
  if (s.prUrl) bits.push(s.prUrl);
  if (s.previewUrl) bits.push(`preview ${s.previewStatus ?? ""} ${s.previewUrl}`.trim());
  if (s.risk) bits.push(`risk ${s.risk.level}`);
  console.log(bits.join("  "));
  if (s.reason) console.log(`    ${s.reason.split("\n").join("\n    ")}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return cmd ? 0 : 2;
  }
  const root = resolve(".");
  const config = loadConfig(root);
  const git = new Git(exec, root);
  const store = new StateStore(await git.stateDir());
  const issueArg = () => {
    const n = Number(rest.find((a) => !a.startsWith("-")));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${cmd} needs an issue number`);
    return n;
  };

  switch (cmd) {
    case "run": {
      const gh = new GitHub(config.repo ?? (await git.remoteRepo()), await token(root));
      const state = await drive(issueArg(), { run: exec, git, gh, config, store, log: (l) => console.log(l) }, { retry: rest.includes("--retry") });
      printState(state);
      return state.phase === "needs-human" ? 1 : 0;
    }
    case "plan": {
      const gh = new GitHub(config.repo ?? (await git.remoteRepo()), await token(root));
      const ticket = ticketFromIssue(await gh.getIssue(issueArg()));
      console.log(`issue     #${ticket.number} ${ticket.title}`);
      console.log(`branch    ${branchName(config.branchPrefix, ticket)} from origin/${config.baseBranch}`);
      console.log(`worktree  ${git.worktreePath(branchName(config.branchPrefix, ticket))}`);
      console.log(`agent     ${config.agent.command.join(" ")} (up to ${config.agent.maxFixRounds} fix rounds)`);
      console.log(`gates     ${config.gates.map((g) => `${g.name}: ${g.run.join(" ")}`).join(" | ") || "(none)"}`);
      console.log(`preview   ${config.preview.enabled ? `wait up to ${config.preview.timeoutSec}s, then GET ${config.preview.path}` : "off"}`);
      console.log(
        `merge     ${config.merge.auto ? `automatic when "${config.merge.requiredCheck}" is green and risk is ${config.merge.maxRisk} or lower` : "a person merges the PR"}`,
      );
      console.log(`\n--- agent brief ---\n${agentPrompt(ticket)}`);
      return 0;
    }
    case "status": {
      const states = rest[0] ? [store.get(issueArg())].filter((s): s is RunState => s !== null) : store.list();
      if (!states.length) console.log("no runs recorded");
      states.forEach(printState);
      return 0;
    }
    case "risk": {
      const i = rest.indexOf("--base");
      const base = i >= 0 && rest[i + 1] ? rest[i + 1]! : config.baseBranch;
      const report = assessRisk(await git.diff(root, base), config.risk);
      console.log(`risk: ${report.level}  (${report.stats.files} files, +${report.stats.added} -${report.stats.removed})`);
      for (const f of report.factors) console.log(`  ${f.level.padEnd(6)} ${f.reason}: ${f.files.slice(0, 5).join(", ")}`);
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: Error) => {
    console.error(`ship-loop: ${e.message}`);
    process.exitCode = 2;
  },
);
