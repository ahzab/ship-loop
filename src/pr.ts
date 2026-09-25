import type { GateResult, RiskReport, Ticket } from "./types.js";

const ICON = { low: "🟢", medium: "🟡", high: "🔴" } as const;

export function prTitle(t: Ticket): string {
  return `${t.title} (#${t.number})`;
}

/** The PR is the review surface, so it carries everything a reviewer needs to decide fast. */
export function prBody(t: Ticket, gates: GateResult[], risk: RiskReport, rounds: number): string {
  const out = [`Closes #${t.number}.`, ""];
  if (t.acceptance.length) {
    out.push("### Acceptance criteria", "", ...t.acceptance.map((a) => `- [ ] ${a}`), "");
  }
  out.push("### Gates", "", "| Gate | Result | Time |", "|---|---|---|");
  for (const g of gates) out.push(`| \`${g.name}\` | ${g.ok ? "pass" : "fail"} | ${(g.ms / 1000).toFixed(1)}s |`);
  out.push("", rounds ? `Passed after ${rounds} fix round(s).` : "Passed on the first attempt.", "");

  out.push(`### Risk: ${ICON[risk.level]} ${risk.level}`, "");
  out.push(`${risk.stats.files} file(s), +${risk.stats.added} / -${risk.stats.removed}.`, "");
  if (risk.factors.length) {
    for (const f of risk.factors) {
      const files = f.files.slice(0, 6).map((p) => `\`${p}\``).join(", ");
      out.push(`- **${f.level}**: ${f.reason} (${files}${f.files.length > 6 ? `, +${f.files.length - 6} more` : ""})`);
    }
  } else {
    out.push("Nothing in the diff touches data, auth, CI or dependencies.");
  }
  if (risk.level === "high") out.push("", "This change waits for a person to review and merge it.");
  return out.join("\n");
}
