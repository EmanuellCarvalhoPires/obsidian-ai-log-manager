// AI Log Manager hook for Claude Code. Usage: node ai-log-manager-hook.mjs
//
// Written by the AI Log Manager plugin to <plugin folder>/hook/ and registered in the Claude
// Code settings for SessionStart, UserPromptSubmit, Stop, SessionEnd and PostToolUse (Bash). It reads the hook JSON
// from stdin and drops one small file in <plugin folder>/spool/. The plugin reads that folder
// (also after Obsidian was closed). Plain Node, no dependencies, no network, no output.
//
// It must never get in the way of the agent: any problem, or more than 2 seconds, ends with
// exit code 0 and no output.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const GUARD_MS = 2000;
const MAX_PROMPT = 4000;
// PostToolUse fires for every Bash call; only these change the repository.
const RELEVANT = /\bgit\b[^\n]*\b(commit|push|init|checkout\s+-b|switch\s+-c|branch|merge|tag)\b|\bgh\s+pr\s+(create|merge)\b/;

function done() {
  process.exit(0);
}

process.on("uncaughtException", done);
setTimeout(done, GUARD_MS);

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("error", done);
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, ""));
    if (typeof input !== "object" || input === null) return done();
    const event = {
      evento: String(input.hook_event_name ?? ""),
      sessao: String(input.session_id ?? ""),
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      transcript_path: typeof input.transcript_path === "string" ? input.transcript_path : undefined,
      prompt: typeof input.prompt === "string" ? input.prompt.slice(0, MAX_PROMPT) : undefined,
      comando:
        input.tool_input && typeof input.tool_input.command === "string" ? input.tool_input.command.slice(0, MAX_PROMPT) : undefined,
      tool: typeof input.tool_name === "string" ? input.tool_name : undefined,
      recebido_em: Date.now(),
    };
    if (!event.evento || !event.sessao) return done();
    if (event.evento === "PostToolUse") {
      if (!event.comando || !RELEVANT.test(event.comando)) return done();
      const r = input.tool_response;
      const out = typeof r === "string" ? r : r && typeof r.stdout === "string" ? r.stdout : "";
      event.saida = out.slice(0, 2000);
    }
    const spool = path.join(path.dirname(path.dirname(path.resolve(process.argv[1] ?? ""))), "spool");
    fs.mkdirSync(spool, { recursive: true });
    const name = `${String(event.recebido_em).padStart(15, "0")}-${crypto.randomBytes(3).toString("hex")}.json`;
    const tmp = path.join(spool, `${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(event), "utf8");
    fs.renameSync(tmp, path.join(spool, name));
  } catch {
    // Fail open.
  }
  done();
});
