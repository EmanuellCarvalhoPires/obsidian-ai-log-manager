// AI Log Manager hook for Claude Code. Usage: node ai-log-manager-hook.mjs
//
// Written by the AI Log Manager plugin to <plugin folder>/hook/ and registered in the Claude
// Code settings for SessionStart, UserPromptSubmit, Stop and SessionEnd. It reads the hook JSON
// from stdin and drops one small file in <plugin folder>/spool/. The plugin reads that folder
// (also after Obsidian was closed). On SessionStart it also outputs the session id as context so
// the agent can pass `sessao` when more than one conversation is active (LM-09).
//
// It must never get in the way of the agent: any problem, or more than 2 seconds, ends with
// exit code 0.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const GUARD_MS = 2000;
const MAX_PROMPT = 4000;
// Only these events matter; anything else (for example the PostToolUse of an older install) is dropped at once.
const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);

const MASK = "[REDACTED]";
const PLACEHOLDER = /\{\{\s*[A-Za-z][\w-]*\s*:[^{}]*\}\}/g;
const SENTINEL = "\uE000";
const TOKEN_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bATATT[A-Za-z0-9_=+/-]{20,}/g,
  /\bevc_[0-9a-fA-F]{8,}/g,
  /\baie_[0-9a-fA-F]{8,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
];

function redactPrompt(text) {
  if (!text) return text;
  const placeholders = [];
  let s = text.replace(PLACEHOLDER, (m) => {
    placeholders.push(m);
    return `${SENTINEL}${placeholders.length - 1}${SENTINEL}`;
  });
  for (const re of TOKEN_SHAPES) s = s.replace(re, MASK);
  return s.replace(/\uE000(\d+)\uE000/g, (_m, i) => placeholders[Number(i)] ?? "");
}

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
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
    if (typeof input !== "object" || input === null) return done();
    const rawPrompt = typeof input.prompt === "string" ? input.prompt.slice(0, MAX_PROMPT) : undefined;
    const event = {
      evento: String(input.hook_event_name ?? ""),
      sessao: String(input.session_id ?? ""),
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      transcript_path: typeof input.transcript_path === "string" ? input.transcript_path : undefined,
      prompt: rawPrompt ? redactPrompt(rawPrompt) : undefined,
      recebido_em: Date.now(),
    };
    if (!event.evento || !event.sessao || !EVENTS.has(event.evento)) return done();
    const spool = path.join(path.dirname(path.dirname(path.resolve(process.argv[1] ?? ""))), "spool");
    fs.mkdirSync(spool, { recursive: true });
    const name = `${String(event.recebido_em).padStart(15, "0")}-${crypto.randomBytes(3).toString("hex")}.json`;
    const tmp = path.join(spool, `${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(event), "utf8");
    fs.renameSync(tmp, path.join(spool, name));
    if (event.evento === "SessionStart") {
      const out = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `AI Log Manager: sessao="${event.sessao}"`,
        },
      };
      process.stdout.write(`${JSON.stringify(out)}\n`, done);
      return;
    }
  } catch {
    // Fail open.
  }
  done();
});
