import type { Gate } from "./config.js";
import type { GateResult, Runner } from "./types.js";
import { tail } from "./exec.js";

/**
 * Run every gate, in order, even after one fails: the agent fixes better when it
 * sees all the failures at once than when it learns about them one round at a time.
 */
export async function runGates(run: Runner, cwd: string, gates: Gate[]): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const g of gates) {
    const start = Date.now();
    const r = await run(g.run, { cwd, env: { CI: "true" } });
    results.push({ name: g.name, command: g.run, ok: r.code === 0, output: tail(r), ms: Date.now() - start });
  }
  return results;
}

export const allPassed = (results: GateResult[]) => results.every((r) => r.ok);
