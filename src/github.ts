import type { Check, CheckState, PullRequest } from "./types.js";

export interface GitHubApi {
  getIssue(n: number): Promise<{ number: number; title: string; body: string | null; html_url: string; state: string; pull_request?: unknown }>;
  findOpenPr(head: string): Promise<PullRequest | null>;
  getPr(n: number): Promise<PullRequest>;
  createPr(p: { title: string; body: string; head: string; base: string }): Promise<PullRequest>;
  updatePrBody(n: number, body: string): Promise<void>;
  addLabel(n: number, label: string): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  getChecks(sha: string): Promise<Check[]>;
  /** The newest successful deployment's URL for a commit, if the host reported one. */
  previewUrl(sha: string): Promise<string | null>;
  merge(n: number, sha: string, method: "squash" | "merge" | "rebase"): Promise<void>;
}

export class GitHubHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Fetch = typeof fetch;

function toPr(p: any): PullRequest {
  return {
    number: p.number,
    url: p.html_url,
    headSha: p.head.sha,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    draft: Boolean(p.draft),
    state: p.state,
    merged: Boolean(p.merged ?? p.merged_at),
  };
}

function checkRunState(r: { status: string; conclusion: string | null }): CheckState {
  if (r.status !== "completed") return "pending";
  switch (r.conclusion) {
    case "success": return "success";
    case "neutral": return "neutral";
    case "skipped": return "skipped";
    default: return "failure"; // failure, cancelled, timed_out, action_required, stale
  }
}

function statusState(s: string): CheckState {
  return s === "success" ? "success" : s === "pending" ? "pending" : "failure";
}

export class GitHub implements GitHubApi {
  private readonly base = "https://api.github.com";

  constructor(private readonly repo: string, private readonly token: string, private readonly fetchImpl: Fetch = fetch) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).message ?? text; } catch { /* not JSON: keep the raw text */ }
      throw new GitHubHttpError(res.status, `GitHub ${method} ${path}: ${res.status} ${msg}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  getIssue(n: number) {
    return this.req<any>("GET", `/issues/${n}`);
  }

  async findOpenPr(head: string) {
    const owner = this.repo.split("/")[0];
    const prs = await this.req<any[]>("GET", `/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    return prs[0] ? toPr(prs[0]) : null;
  }

  async getPr(n: number) {
    return toPr(await this.req<any>("GET", `/pulls/${n}`));
  }

  async createPr(p: { title: string; body: string; head: string; base: string }) {
    return toPr(await this.req<any>("POST", "/pulls", p));
  }

  async updatePrBody(n: number, body: string) {
    await this.req("PATCH", `/pulls/${n}`, { body });
  }

  async addLabel(n: number, label: string) {
    await this.req("POST", `/issues/${n}/labels`, { labels: [label] });
  }

  async comment(n: number, body: string) {
    await this.req("POST", `/issues/${n}/comments`, { body });
  }

  async getChecks(sha: string): Promise<Check[]> {
    const runs = await this.req<{ check_runs: any[] }>("GET", `/commits/${sha}/check-runs?per_page=100`);
    const combined = await this.req<{ statuses: any[] }>("GET", `/commits/${sha}/status`);
    return [
      ...runs.check_runs.map((r) => ({ name: r.name, state: checkRunState(r), url: r.html_url })),
      ...combined.statuses.map((s) => ({ name: s.context, state: statusState(s.state), url: s.target_url ?? undefined })),
    ];
  }

  async previewUrl(sha: string): Promise<string | null> {
    const deployments = await this.req<any[]>("GET", `/deployments?sha=${sha}&per_page=10`);
    for (const d of deployments) {
      const statuses = await this.req<any[]>("GET", `/deployments/${d.id}/statuses?per_page=10`);
      const ok = statuses.find((s) => s.state === "success" && (s.environment_url || s.target_url));
      if (ok) return ok.environment_url || ok.target_url;
    }
    return null;
  }

  async merge(n: number, sha: string, method: "squash" | "merge" | "rebase") {
    // `sha` makes GitHub refuse the merge if the branch moved after the checks we read.
    await this.req("PUT", `/pulls/${n}/merge`, { sha, merge_method: method });
  }
}
