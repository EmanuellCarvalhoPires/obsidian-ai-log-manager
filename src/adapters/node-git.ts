// GitRunner on top of the git executable (desktop only).
import { execFile } from "node:child_process";
import type { GitRunner } from "../core/ports";

export function createNodeGit(): GitRunner {
  return (cwd, args) =>
    new Promise<string>((resolve, reject) => {
      execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      });
    });
}
