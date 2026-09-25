import { spawn } from "node:child_process";
import type { ExecResult, Runner } from "./types.js";

const MAX_CAPTURE = 2 * 1024 * 1024;

export const run: Runner = (cmd, opts) =>
  new Promise<ExecResult>((resolve) => {
    const [bin, ...args] = cmd;
    if (!bin) return resolve({ code: 127, stdout: "", stderr: "empty command" });
    const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < MAX_CAPTURE) stderr += d.toString(); });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });

/** Last `n` lines of combined output: what a person or an agent needs to see a failure. */
export function tail(r: ExecResult, n = 60): string {
  return `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-n).join("\n");
}
