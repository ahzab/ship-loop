import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Gate {
  name: string;
  run: string[];
}

export interface Config {
  /** owner/name. Read from the origin remote when omitted. */
  repo?: string;
  baseBranch: string;
  branchPrefix: string;
  /** Files copied into each new worktree: gitignored, but needed to build or deploy. */
  copyIntoWorktree: string[];
  install: string[] | null;
  agent: {
    /** The prompt is passed on stdin. */
    command: string[];
    /** How many times failing gates are handed back to the agent before a person is asked. */
    maxFixRounds: number;
  };
  gates: Gate[];
  risk: {
    /** Globs (a `*` matches within a path segment, `**` across segments) that make a change high risk. */
    high: string[];
    medium: string[];
    /** Changed lines above which a diff is medium, and above twice this, high. */
    maxLines: number;
  };
  preview: {
    /** Off for repos with no preview deployments: the run goes from PR straight to the merge gate. */
    enabled: boolean;
    /** Poll GitHub deployments for the preview URL this long before giving up. */
    timeoutSec: number;
    /** Path requested on the preview to prove it serves the app, e.g. /api/health. */
    path: string;
  };
  merge: {
    /** Off by default: without it ship-loop stops at a verified preview and a PR. */
    auto: boolean;
    method: "squash" | "merge" | "rebase";
    /** The CI check that must be present and green. Vercel's own statuses do not count. */
    requiredCheck: string | null;
    /** Highest diff risk allowed to merge unattended. */
    maxRisk: "low" | "medium";
    timeoutSec: number;
  };
}

export const DEFAULTS: Config = {
  baseBranch: "main",
  branchPrefix: "ship/",
  copyIntoWorktree: [".env", ".env.local", ".vercel"],
  install: ["npm", "ci"],
  agent: {
    command: ["claude", "-p", "--permission-mode", "acceptEdits"],
    maxFixRounds: 3,
  },
  gates: [
    { name: "test", run: ["npm", "test"] },
    { name: "build", run: ["npm", "run", "build"] },
  ],
  risk: {
    high: [
      "**/migrations/**",
      "**/*.sql",
      "**/middleware.*",
      "**/auth/**",
      "**/*auth*.*",
      "**/*permission*.*",
      "**/*policy*.*",
      ".github/workflows/**",
    ],
    medium: ["package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/.env*", "**/next.config.*", "**/vercel.json", "**/Dockerfile"],
    maxLines: 400,
  },
  preview: { enabled: true, timeoutSec: 600, path: "/" },
  merge: { auto: false, method: "squash", requiredCheck: null, maxRisk: "low", timeoutSec: 1800 },
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge a user config over the defaults. Arrays replace, they do not concatenate. */
function merge<T>(base: T, over: unknown): T {
  if (!isObject(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = isObject(b) && isObject(v) ? merge(b, v) : v;
  }
  return out as T;
}

export function validate(c: Config): string[] {
  const errors: string[] = [];
  const isCmd = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string");
  if (!isCmd(c.agent.command)) errors.push("agent.command must be a non-empty array of strings");
  if (!Number.isInteger(c.agent.maxFixRounds) || c.agent.maxFixRounds < 0 || c.agent.maxFixRounds > 10) {
    errors.push("agent.maxFixRounds must be an integer from 0 to 10");
  }
  if (!Array.isArray(c.gates) || c.gates.some((g) => typeof g.name !== "string" || !isCmd(g.run))) {
    errors.push("gates must be a list of { name, run: [command, ...args] }");
  }
  if (c.install !== null && !isCmd(c.install)) errors.push("install must be a command array or null");
  if (!["squash", "merge", "rebase"].includes(c.merge.method)) errors.push("merge.method must be squash, merge or rebase");
  if (!["low", "medium"].includes(c.merge.maxRisk)) errors.push("merge.maxRisk must be low or medium: high-risk changes always wait for a person");
  if (c.merge.auto && !c.merge.requiredCheck) {
    errors.push("merge.auto needs merge.requiredCheck: without a named CI check, 'all checks green' can be true while nothing ran");
  }
  if (c.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) errors.push("repo must look like owner/name");
  return errors;
}

export function loadConfig(root: string): Config {
  const path = join(root, "ship-loop.config.json");
  let user: unknown = {};
  if (existsSync(path)) {
    try {
      user = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`ship-loop.config.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  const config = merge(DEFAULTS, user);
  const errors = validate(config);
  if (errors.length) throw new Error(`ship-loop.config.json:\n  - ${errors.join("\n  - ")}`);
  return config;
}
