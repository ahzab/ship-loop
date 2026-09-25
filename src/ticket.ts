import type { Ticket } from "./types.js";

/** Checkbox lines, checked or not: `- [ ] text` / `* [x] text`. */
export function acceptanceCriteria(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

export function ticketFromIssue(issue: { number: number; title: string; body: string | null; html_url: string }): Ticket {
  const body = issue.body ?? "";
  return { number: issue.number, title: issue.title.trim(), body, acceptance: acceptanceCriteria(body), url: issue.html_url };
}

/** `ship/42-add-csv-export`: readable in the PR list, unique per issue, safe for git. */
export function branchName(prefix: string, t: Pick<Ticket, "number" | "title">): string {
  const slug = t.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${prefix}${t.number}${slug ? `-${slug}` : ""}`;
}

/**
 * The brief the agent gets. It states the definition of done and the limits of
 * the job; everything about how to write the code comes from the repo itself
 * (CLAUDE.md, AGENTS.md, the existing code), which the agent reads on its own.
 */
export function agentPrompt(t: Ticket, gateFailures?: { name: string; output: string }[]): string {
  const lines = [
    `You are working on issue #${t.number}: ${t.title}`,
    "",
    t.body.trim() || "(no description)",
    "",
  ];
  if (t.acceptance.length) {
    lines.push("Done means every one of these holds:", ...t.acceptance.map((a) => `- ${a}`), "");
  }
  lines.push(
    "Rules:",
    "- You are in a git worktree on a branch made for this issue. Stay in it.",
    "- Do not commit, push, merge or change branches. ship-loop commits and opens the PR.",
    "- Follow the repo's own conventions (CLAUDE.md, AGENTS.md, README, the surrounding code).",
    "- Add or update tests for the behaviour you change.",
    "- Keep the change to what the issue asks. Note anything else you noticed instead of fixing it.",
    "- Do not run database migrations against a real database, and do not edit secrets.",
  );
  if (gateFailures?.length) {
    lines.push("", "Your previous attempt failed these checks. Fix the cause, not the check:");
    for (const g of gateFailures) lines.push("", `## ${g.name}`, "```", g.output.trim(), "```");
  }
  return lines.join("\n");
}
