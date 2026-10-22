import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HookHandler } from "../../src/core/hook-handler";
import type { ProjectPrompter } from "../../src/core/hook-handler";
import { ProjectCreator } from "../../src/core/project-creator";
import { HOOK_EVENTS, hookCommand, hooksInstalled, installedEvents, mergeHooks, removeHooks } from "../../src/hook/hook-installer";
import type { ClaudeSettings } from "../../src/hook/hook-installer";
import { assistantLine, makeHarness, userLine } from "../helpers/memory-ports";

const SCRIPT = "C:/vault/.obsidian/plugins/ai-log-manager/hook/ai-log-manager-hook.mjs";

describe("hook installer", () => {
  it("adds the four events and keeps other tools' hooks", () => {
    const other: ClaudeSettings = {
      model: "x",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "python other.py" }] }] },
    };
    const { settings, changed } = mergeHooks(other, SCRIPT);
    expect(changed).toBe(true);
    expect(settings.model).toBe("x");
    expect(Object.keys(settings.hooks!).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(settings.hooks!.Stop).toHaveLength(2);
    expect(settings.hooks!.Stop![0]!.hooks![0]!.command).toBe("python other.py");
    expect(hooksInstalled(settings, SCRIPT)).toBe(true);
  });

  it("is idempotent", () => {
    const once = mergeHooks({}, SCRIPT).settings;
    const twice = mergeHooks(once, SCRIPT);
    expect(twice.changed).toBe(false);
    expect(twice.settings).toEqual(once);
  });

  it("reports partial installs and removes only its own entries", () => {
    const partial: ClaudeSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: hookCommand(SCRIPT) }] }] } };
    expect(installedEvents(partial, SCRIPT)).toEqual(["Stop"]);
    expect(hooksInstalled(partial, SCRIPT)).toBe(false);
    const full = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "python other.py" }] }] } }, SCRIPT).settings;
    const removed = removeHooks(full, SCRIPT);
    expect(removed.changed).toBe(true);
    expect(removed.settings.hooks!.Stop).toHaveLength(1);
    expect(removed.settings.hooks!.SessionStart).toBeUndefined();
  });
});

describe("hook script", () => {
  it("drops one event file in the spool and prints nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-"));
    try {
      fs.mkdirSync(path.join(dir, "hook"));
      const script = path.join(dir, "hook", "ai-log-manager-hook.mjs");
      fs.copyFileSync(path.join(__dirname, "../../src/hook/ai-log-manager-hook.mjs"), script);
      const out = execFileSync(process.execPath, [script], {
        input: JSON.stringify({ hook_event_name: "Stop", session_id: "abc", cwd: "C:/x", transcript_path: "C:/t.jsonl" }),
        encoding: "utf8",
      });
      expect(out).toBe("");
      const files = fs.readdirSync(path.join(dir, "spool"));
      expect(files).toHaveLength(1);
      const event = HookHandler.parse(JSON.parse(fs.readFileSync(path.join(dir, "spool", files[0]!), "utf8")));
      expect(event).toMatchObject({ evento: "Stop", sessao: "abc", cwd: "C:/x", transcript_path: "C:/t.jsonl" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores garbage input without failing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-"));
    try {
      fs.mkdirSync(path.join(dir, "hook"));
      const script = path.join(dir, "hook", "ai-log-manager-hook.mjs");
      fs.copyFileSync(path.join(__dirname, "../../src/hook/ai-log-manager-hook.mjs"), script);
      expect(execFileSync(process.execPath, [script], { input: "not json", encoding: "utf8" })).toBe("");
      expect(fs.existsSync(path.join(dir, "spool"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("HookHandler", () => {
  const T1 = "2026-10-21T15:00:00.000Z";
  const T2 = "2026-10-21T15:01:00.000Z";

  function setup(answer: boolean) {
    const h = makeHarness();
    const asked: Array<{ cwd: string; name: string }> = [];
    const prompter: ProjectPrompter = {
      confirmNewProject: async (info) => {
        asked.push(info);
        return answer;
      },
    };
    const creator = new ProjectCreator(h.vault, () => h.settings, () => undefined);
    const created: string[] = [];
    const handler = new HookHandler(h.engine, h.tracker, h.store, creator, prompter, (n) => created.push(n));
    return { h, handler, asked, created };
  }

  it("parses endpoint bodies and rejects incomplete ones", () => {
    expect(HookHandler.parse({ evento: "Stop", sessao: "s" })).toMatchObject({ evento: "Stop", sessao: "s" });
    expect(HookHandler.parse({ hook_event_name: "Stop", session_id: "s" })).toMatchObject({ sessao: "s" });
    expect(HookHandler.parse({ evento: "Stop" })).toBeUndefined();
    expect(HookHandler.parse("x")).toBeUndefined();
  });

  it("Stop updates the log right away", async () => {
    const { h, handler } = setup(true);
    h.disk.put(h.transcript, userLine("Oi", T1) + assistantLine("Olá.", T2));
    const res = await handler.handle({ evento: "Stop", sessao: "sess-1", transcript_path: h.transcript });
    expect(res.action).toBe("sync:created");
    expect(h.vault.notes.size).toBe(1);
  });

  it("UserPromptSubmit links the project cited in the prompt", async () => {
    const { h, handler } = setup(true);
    h.vault.projectList = [{ name: "Projeto Exemplo", folder: "Projetos/Projeto Exemplo", clonePath: undefined }];
    const res = await handler.handle({ evento: "UserPromptSubmit", sessao: "sess-1", prompt: "melhora o Projeto Exemplo hoje", transcript_path: h.transcript });
    expect(res.action).toBe("link-pending");
    h.disk.put(h.transcript, userLine("melhora o Projeto Exemplo hoje", T1) + assistantLine("Ok.", T2));
    const created = await h.engine.syncTranscript(h.transcript);
    expect(created.notaLog).toMatch(/^Projetos\/Projeto Exemplo\/Logs\//);
  });

  it("SessionStart in a git repo without a project note asks first and creates nothing before the yes", async () => {
    const { h, handler, asked } = setup(false);
    h.disk.put("C:/Dev/novo-app/.git/HEAD", "ref");
    const res = await handler.handle({ evento: "SessionStart", sessao: "s", cwd: "C:/Dev/novo-app" });
    expect(res.action).toBe("declined");
    expect(asked).toEqual([{ cwd: "C:/Dev/novo-app", name: "novo-app" }]);
    expect(h.vault.notes.size).toBe(0);
    // the answer is remembered: it does not ask again
    expect((await handler.handle({ evento: "SessionStart", sessao: "s2", cwd: "C:/Dev/novo-app" })).action).toBe("already-answered");
    expect(asked).toHaveLength(1);
  });

  it("creates the project folder, indexes and CLAUDE.md only after the yes", async () => {
    const { h, handler, created } = setup(true);
    h.disk.put("C:/Dev/novo-app/.git/HEAD", "ref");
    const res = await handler.handle({ evento: "SessionStart", sessao: "s", cwd: "C:/Dev/novo-app" });
    expect(res.action).toBe("project-created");
    expect(created).toEqual(["novo-app"]);
    expect([...h.vault.notes.keys()].sort()).toEqual([
      "Projetos/novo-app/CLAUDE.md",
      "Projetos/novo-app/Changelogs/novo-app - Changelog.md",
      "Projetos/novo-app/Logs/novo-app - Logs.md",
      "Projetos/novo-app/novo-app.md",
    ]);
    expect(h.vault.notes.get("Projetos/novo-app/novo-app.md")).toContain("- **Clone local:** `C:/Dev/novo-app`");
    expect(h.vault.notes.get("Projetos/novo-app/novo-app.md")).toContain("  - dev/projeto");
  });

  it("does not ask for the vault itself, tracked folders or a known project", async () => {
    const { h, handler, asked } = setup(true);
    h.disk.put("C:/Cofre/.git/HEAD", "ref");
    expect((await handler.handle({ evento: "SessionStart", sessao: "s", cwd: "C:/Cofre" })).action).toBe("not-a-candidate");
    h.vault.projectList = [{ name: "App", folder: "Projetos/App", clonePath: "C:/Dev/app" }];
    h.tracker.invalidate();
    h.disk.put("C:/Dev/app/.git/HEAD", "ref");
    expect((await handler.handle({ evento: "SessionStart", sessao: "s", cwd: "C:/Dev/app" })).action).toBe("not-a-candidate");
    expect(asked).toHaveLength(0);
  });
});

describe("hook script (PostToolUse)", () => {
  function run(input: unknown): string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-"));
    try {
      fs.mkdirSync(path.join(dir, "hook"));
      const script = path.join(dir, "hook", "ai-log-manager-hook.mjs");
      fs.copyFileSync(path.join(__dirname, "../../src/hook/ai-log-manager-hook.mjs"), script);
      execFileSync(process.execPath, [script], { input: JSON.stringify(input), encoding: "utf8" });
      const spool = path.join(dir, "spool");
      return fs.existsSync(spool) ? fs.readdirSync(spool).map((f) => fs.readFileSync(path.join(spool, f), "utf8")) : [];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("drops only repository commands, with their output", () => {
    const base = { hook_event_name: "PostToolUse", session_id: "s", cwd: "C:/x", tool_name: "Bash" };
    expect(run({ ...base, tool_input: { command: "npm test" } })).toEqual([]);
    expect(run({ ...base, tool_input: { command: "git status" } })).toEqual([]);
    const [one] = run({ ...base, tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: "https://github.com/o/r/pull/3" } });
    const event = HookHandler.parse(JSON.parse(one!));
    expect(event).toMatchObject({ evento: "PostToolUse", comando: "gh pr create --fill", saida: "https://github.com/o/r/pull/3" });
  });
});
