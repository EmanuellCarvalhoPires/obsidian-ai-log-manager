import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Plugin } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import { CHECKPOINT_SAVE_DELAY_MS, CheckpointStore } from "../../src/core/checkpoints";
import type { Checkpoint } from "../../src/core/checkpoints";
import { STALE_TURN_MS } from "../../src/core/engine";
import { HookHandler } from "../../src/core/hook-handler";
import type { HookEvent, ProjectPrompter } from "../../src/core/hook-handler";
import { ProjectCreator } from "../../src/core/project-creator";
import { redactSecrets } from "../../src/core/redactor";
import { appendTranscriptChunk, createIncrementalState } from "../../src/core/transcript";
import { watchFolder } from "../../src/core/watcher";
import {
  applyClaudeHooksSafe,
  checkNodeInPath,
  MAX_SESSION_START_AGE_MS,
  MAX_SPOOL_AGE_MS,
  readClaudeSettingsSafe,
  SpoolDrainer,
} from "../../src/hook/hook-installer";
import { buildTools, resolveSession } from "../../src/tools/log-module";
import { AILogManagerSettingTab } from "../../src/ui/settings-tab";
import type { SettingsHost } from "../../src/ui/settings-tab";
import { assistantLine, makeHarness, userLine } from "../helpers/memory-ports";

const SCRIPT = "C:/vault/.obsidian/plugins/ai-log-manager/hook/ai-log-manager-hook.mjs";
const T1 = "2026-10-21T15:00:00.000Z";
const T2 = "2026-10-21T15:00:15.000Z";
const T3 = "2026-10-21T15:00:30.000Z";
const T4 = "2026-10-21T15:00:45.000Z";
const T5 = "2026-10-21T15:05:00.000Z";
const T6 = "2026-10-21T15:06:00.000Z";

class DummyPlugin extends Plugin {}

const customUserLine = (text: string, iso: string, sessionId: string, cwd = "C:/Cofre"): string =>
  `${JSON.stringify({ type: "user", timestamp: iso, cwd, sessionId, message: { role: "user", content: text } })}\n`;

const sidechain = (line: string): string => `${JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), isSidechain: true, agentId: "sub123" })}\n`;

describe("LM-01: Safe Claude settings read, atomic write, and backups", () => {
  it("refuses to overwrite corrupt JSON in settings.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-lm01-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(settingsPath, "{ invalid json // comment", "utf8");
      await expect(readClaudeSettingsSafe(settingsPath)).rejects.toThrow(/not valid JSON/);
      await expect(applyClaudeHooksSafe(settingsPath, SCRIPT)).rejects.toThrow(/not valid JSON/);
      expect(fs.readFileSync(settingsPath, "utf8")).toBe("{ invalid json // comment");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically and rotates up to 5 timestamped backups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-lm01-bak-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      for (let i = 0; i < 7; i++) {
        fs.writeFileSync(settingsPath, JSON.stringify({ model: "opus", iteration: i }), "utf8");
        await applyClaudeHooksSafe(settingsPath, SCRIPT, 1_700_000_000_000 + i * 1000);
      }

      const { settings } = await readClaudeSettingsSafe(settingsPath);
      expect(settings.model).toBe("opus");
      expect(settings.iteration).toBe(6);

      const backups = fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.") && f.endsWith(".ai-log-manager.bak"));
      expect(backups).toHaveLength(5);
      expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LM-02: Multi-part assistant response continuation", () => {
  it("appends Resposta (continuação) when an already-recorded turn receives more assistant messages", async () => {
    const h = makeHarness();
    const initial = userLine("Roda o subagente em background", T1) + assistantLine("Iniciei o subagente.", T2);
    h.disk.put(h.transcript, initial, 1000);
    const first = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    expect(first.status).toBe("created");

    const taskNotif = `${JSON.stringify({
      type: "user",
      sessionId: "sess-1",
      cwd: "C:/Cofre",
      timestamp: T3,
      message: { role: "user", content: "<task-notification>Subagente terminou</task-notification>" },
    })}\n`;
    h.disk.append(h.transcript, taskNotif + assistantLine("O subagente concluiu com sucesso.", T4), 2000);

    const second = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    expect(second.status).toBe("updated");
    expect(second.added).toBe(1);
    const content = h.vault.notes.get(first.notaLog!)!;
    expect(content).toContain("**Resposta:** Iniciei o subagente.");
    expect(content).toContain("**Resposta (continuação):** O subagente concluiu com sucesso.");
  });
});

describe("LM-03: Secret redaction in logs, facts, and hook spool", () => {
  it("masks secrets with [REDACTED] while preserving {{secret:...}} placeholders", () => {
    const sample = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "Header {{bearer:JIRA_TOKEN}} and {{secret:API_KEY}} and {{basic:AUTH}}",
      "ghp_1234567890abcdefghijklmnopqrstuvwx",
      "eco_1234567890abcdef1234567890abcdef",
      "sk-ant-api03-1234567890abcdefghijklmnopqrstuvwx",
      '{"access_token": "super-secret-value-123456"}',
      "https://example.com/api?api_key=mySecretKey987654321&ok=1",
    ].join("\n");

    const redacted = redactSecrets(sample);
    expect(redacted).toContain("{{bearer:JIRA_TOKEN}}");
    expect(redacted).toContain("{{secret:API_KEY}}");
    expect(redacted).toContain("{{basic:AUTH}}");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("ghp_1234567890");
    expect(redacted).not.toContain("eco_1234567890");
    expect(redacted).not.toContain("sk-ant-api03-");
    expect(redacted).not.toContain("super-secret-value-123456");
    expect(redacted).not.toContain("mySecretKey987654321");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts secrets in log entries and facts via LogEngine", async () => {
    const h = makeHarness();
    h.disk.put(
      h.transcript,
      userLine("Use token ghp_1234567890abcdefghijklmnopqrstuvwx e {{secret:MEU_TOKEN}}", T1) +
        assistantLine("Usando Bearer secretTokenValue1234567890", T2),
      1000,
    );
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    await h.engine.addFacts("sess-1", ["Chave eco_1234567890abcdef1234567890abcdef configurada"]);
    const content = h.vault.notes.get(created.notaLog!)!;
    expect(content).toContain("{{secret:MEU_TOKEN}}");
    expect(content).not.toContain("ghp_1234567890");
    expect(content).not.toContain("secretTokenValue1234567890");
    expect(content).not.toContain("eco_1234567890");
    expect(content).toContain("[REDACTED]");
  });

  it("redacts secrets in the hook spool script before writing to disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-lm03-"));
    try {
      fs.mkdirSync(path.join(dir, "hook"));
      const script = path.join(dir, "hook", "ai-log-manager-hook.mjs");
      fs.copyFileSync(path.join(__dirname, "../../src/hook/ai-log-manager-hook.mjs"), script);
      execFileSync(process.execPath, [script], {
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-sec",
          prompt: "Meu token é ghp_1234567890abcdefghijklmnopqrstuvwx e {{secret:OK}}",
        }),
        encoding: "utf8",
      });
      const files = fs.readdirSync(path.join(dir, "spool"));
      const raw = fs.readFileSync(path.join(dir, "spool", files[0]), "utf8");
      expect(raw).not.toContain("ghp_1234567890");
      expect(raw).toContain("[REDACTED]");
      expect(raw).toContain("{{secret:OK}}");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LM-04: Disambiguating filename when timestamp and title collide", () => {
  it("appends short session ID suffix when target note path already exists", async () => {
    const h = makeHarness();
    const tA = `${h.settings.claudeHome}/projects/proj/aaaa1111-2222.jsonl`;
    const tB = `${h.settings.claudeHome}/projects/proj/bbbb9999-3333.jsonl`;
    h.disk.put(tA, customUserLine("Mesmo título", T1, "aaaa1111-2222") + assistantLine("ok", T2), 1000);
    h.disk.put(tB, customUserLine("Mesmo título", T1, "bbbb9999-3333") + assistantLine("ok", T2), 1000);

    const resA = await h.engine.syncTranscript(tA, { tzOffsetMinutes: -180 });
    const resB = await h.engine.syncTranscript(tB, { tzOffsetMinutes: -180 });

    expect(resA.status).toBe("created");
    expect(resB.status).toBe("created");
    expect(resA.notaLog).not.toBe(resB.notaLog);
    expect(resB.notaLog).toContain("(bbbb99).md");
  });
});

describe("LM-05: Stale unfinished turn flush during reconciliation", () => {
  it("flushes an unfinished turn when transcript is older than STALE_TURN_MS", async () => {
    let clock = 1_000_000;
    const h = makeHarness({}, () => clock);
    h.disk.put(
      h.transcript,
      userLine("Primeiro turno", T1) + assistantLine("Resposta 1", T2) + userLine("Segundo turno sem resposta", T5),
      clock,
    );

    await h.engine.syncAll({ tzOffsetMinutes: -180 });
    expect(h.store.get("sess-1")?.temTurnoPendente).toBe(true);
    const notePath = h.store.get("sess-1")?.notaLog;
    expect(notePath).toBeDefined();
    expect(h.vault.notes.get(notePath!)).not.toContain("Segundo turno sem resposta");

    clock += STALE_TURN_MS + 1000;
    await h.engine.syncAll({ tzOffsetMinutes: -180 });

    expect(h.store.get("sess-1")?.temTurnoPendente).toBe(false);
    expect(h.vault.notes.get(notePath!)).toContain("Segundo turno sem resposta");
  });
});

describe("LM-06: UserPromptSubmit does not overwrite already-linked project", () => {
  it("keeps project A when prompt mentions project B", async () => {
    const h = makeHarness();
    h.vault.projectList = [
      { name: "Projeto Alfa", folder: "Projetos/Projeto Alfa", clonePath: "C:/clones/alfa" },
      { name: "Projeto Beta", folder: "Projetos/Projeto Beta", clonePath: "C:/clones/beta" },
    ];
    const prompter: ProjectPrompter = { confirmNewProject: async () => false };
    const creator = new ProjectCreator(h.vault, () => h.settings, () => undefined);
    const handler = new HookHandler(h.engine, h.tracker, h.store, creator, prompter, () => h.settings);

    const r1 = await handler.handle({ evento: "UserPromptSubmit", sessao: "sess-1", cwd: "C:/Cofre", prompt: "Vamos mexer no Projeto Alfa" });
    expect(r1).toMatchObject({ ok: true, action: "link-pending", detail: "Projeto Alfa" });

    const r2 = await handler.handle({ evento: "UserPromptSubmit", sessao: "sess-1", cwd: "C:/Cofre", prompt: "Compare com o Projeto Beta" });
    expect(r2).toMatchObject({ ok: true, action: "already-linked", detail: "Projeto Alfa" });
    expect(h.store.get("sess-1")?.projeto).toBe("Projeto Alfa");
  });

  it("does not overwrite project when cwd is already inside a tracked project clone", async () => {
    const h = makeHarness();
    h.vault.projectList = [
      { name: "Projeto Alfa", folder: "Projetos/Projeto Alfa", clonePath: "C:/clones/alfa" },
      { name: "Projeto Beta", folder: "Projetos/Projeto Beta", clonePath: "C:/clones/beta" },
    ];
    const prompter: ProjectPrompter = { confirmNewProject: async () => false };
    const creator = new ProjectCreator(h.vault, () => h.settings, () => undefined);
    const handler = new HookHandler(h.engine, h.tracker, h.store, creator, prompter, () => h.settings);

    const res = await handler.handle({
      evento: "UserPromptSubmit",
      sessao: "sess-cwd",
      cwd: "C:/clones/alfa/src",
      prompt: "Veja como o Projeto Beta faz isso",
    });
    expect(res).toMatchObject({ ok: true, action: "already-linked", detail: "Projeto Alfa" });
  });
});

describe("LM-07 & LM-15: Incremental transcript parsing, checkpoint debounce/pruning", () => {
  it("parses JSONL chunks incrementally across partial lines", () => {
    const state = createIncrementalState();
    const uLine = userLine("Pergunta incremental", T1);
    const aLine = assistantLine("Resposta incremental", T2);
    const splitAt = uLine.length + Math.floor(aLine.length / 2);
    const full = uLine + aLine;

    const firstPass = appendTranscriptChunk(state, full.slice(0, splitAt), -180);
    expect(firstPass.turns).toHaveLength(1);
    expect(firstPass.turns[0].complete).toBe(false);

    const parsed = appendTranscriptChunk(state, full.slice(splitAt), -180);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].complete).toBe(true);
    expect(parsed.turns[0].userText).toBe("Pergunta incremental");
    expect(parsed.turns[0].assistantTexts).toEqual(["Resposta incremental"]);
  });

  it("uses 5s checkpoint save delay, skips no-op set(), and prunes missing transcripts without notes", () => {
    expect(CHECKPOINT_SAVE_DELAY_MS).toBe(5_000);
    const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined }, () => 5000);

    const cp: Checkpoint = {
      sessao: "orphan-1",
      hostSessionId: "orphan-1",
      caminhoTranscript: "C:/missing.jsonl",
      offset: 10,
      mtimeMs: 100,
      hashUltimoRegistro: "",
      notaLog: undefined,
      projeto: undefined,
      ignorada: true,
    };
    store.set(cp);
    store.set({ ...cp });
    expect(store.get("orphan-1")).toBeDefined();

    const pruned = store.pruneMissingTranscripts(new Set(["C:/existing.jsonl"]));
    expect(pruned).toBe(1);
    expect(store.get("orphan-1")).toBeUndefined();
  });
});

describe("LM-08: Multi-turn subagent logs", () => {
  it("records all turns of a subagent and appends new turns when updated", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Principal", T1) + assistantLine("Ok", T2), 1000);
    const subPath = h.transcript.replace(/\.jsonl$/, "/subagents/agent-sub123.jsonl");
    const subMeta = h.transcript.replace(/\.jsonl$/, "/subagents/agent-sub123.meta.json");
    h.disk.put(subMeta, JSON.stringify({ agentType: "Explore", description: "Analisar código", finished: true }), 1000);
    h.disk.put(
      subPath,
      sidechain(userLine("Turno 1 do subagente", T1)) +
        sidechain(assistantLine("Resposta 1 do subagente", T2)) +
        sidechain(userLine("Turno 2 do subagente", T3)) +
        sidechain(assistantLine("Resposta 2 do subagente", T4)),
      1000,
    );

    const mainRes = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    const subNote = [...h.vault.notes.keys()].find((k) => k.includes("/Subagentes/"))!;
    expect(subNote).toBeDefined();
    expect(h.vault.notes.get(subNote)).toContain("Turno 1 do subagente");
    expect(h.vault.notes.get(subNote)).toContain("Turno 2 do subagente");

    h.disk.append(subPath, sidechain(userLine("Turno 3 do subagente", T5)) + sidechain(assistantLine("Resposta 3 do subagente", T6)), 2000);
    await h.engine.syncTranscript(h.transcript, { force: true, tzOffsetMinutes: -180 });
    expect(h.vault.notes.get(subNote)).toContain("Turno 3 do subagente");
    expect(mainRes.notaLog).toBeDefined();
    expect(h.vault.frontmatterEdits.some((e) => e.includes("subagentes"))).toBe(true);
  });
});

describe("LM-09: Session ambiguity diagnostics and SessionStart hook context", () => {
  it("includes cwd and first prompt in ambiguity error when multiple sessions are active", async () => {
    const h = makeHarness({}, () => 10_000);
    const t1 = `${h.settings.claudeHome}/projects/proj/s1.jsonl`;
    const t2 = `${h.settings.claudeHome}/projects/proj/s2.jsonl`;
    h.disk.put(t1, customUserLine("Investigar bug no motor de busca", T1, "s1", "C:/Cofre") + assistantLine("ok", T2), 9_500);
    h.disk.put(t2, customUserLine("Atualizar documentação do plugin", T1, "s2", "C:/Outro") + assistantLine("ok", T2), 9_600);

    const resolved = await resolveSession({ locator: h.locator, store: h.store }, undefined, () => 10_000);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toContain("Investigar bug no motor de busca");
      expect(resolved.error).toContain("Atualizar documentação do plugin");
      expect(resolved.error).toContain("C:/Cofre");
    }
  });

  it("prints SessionStart additionalContext with session ID from hook script", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-lm09-"));
    try {
      fs.mkdirSync(path.join(dir, "hook"));
      const script = path.join(dir, "hook", "ai-log-manager-hook.mjs");
      fs.copyFileSync(path.join(__dirname, "../../src/hook/ai-log-manager-hook.mjs"), script);
      const out = execFileSync(process.execPath, [script], {
        input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-xyz-987", cwd: "C:/Cofre" }),
        encoding: "utf8",
      });
      const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(parsed.hookSpecificOutput?.additionalContext).toContain('sessao="sess-xyz-987"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LM-10 & LM-11: Duplicate short prompts in same minute & timezone stability", () => {
  it("records two identical short prompts ('sim') in the same minute without discarding the second", async () => {
    const h = makeHarness();
    h.disk.put(
      h.transcript,
      userLine("sim", T1) + assistantLine("Primeira confirmação feita.", T2) + userLine("sim", T3) + assistantLine("Segunda confirmação feita.", T4),
      1000,
    );
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    expect(res.added).toBe(2);
    const content = h.vault.notes.get(res.notaLog!)!;
    expect(content).toContain("Primeira confirmação feita.");
    expect(content).toContain("Segunda confirmação feita.");
  });

  it("does not duplicate already-recorded turns when tzOffsetMinutes changes between syncs", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Primeiro pedido", T1) + assistantLine("Resposta 1", T2), 1000);
    const first = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    expect(h.store.get("sess-1")?.ultimoRegistroUtc).toBe(T1);

    h.disk.append(h.transcript, userLine("Segundo pedido", T5) + assistantLine("Resposta 2", T6), 2000);
    const second = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -120 });
    expect(second.added).toBe(1);
    const content = h.vault.notes.get(first.notaLog!)!;
    const matches = content.match(/\*\*Solicitação:\*\* Primeiro pedido/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("LM-12: Rename preserves literal $ patterns", () => {
  it("keeps literal $& and $1 when renaming a session log", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Teste regex", T1) + assistantLine("Ok", T2), 1000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });

    const renamed = await h.engine.rename("sess-1", "Regex $& e $1 no título");
    const content = h.vault.notes.get(renamed.notaLog)!;
    expect(content).toContain("# Regex $& e $1 no título");
  });
});

describe("LM-13: SpoolDrainer single-flight lock and TTL expiration", () => {
  it("discards spool files older than 3 days and ignores stale SessionStart events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-lm13-"));
    try {
      const now = 1_700_500_000_000;
      const oldEvent = path.join(dir, "1-old.json");
      const staleStart = path.join(dir, "2-stale-start.json");
      const freshStop = path.join(dir, "3-fresh-stop.json");

      fs.writeFileSync(oldEvent, JSON.stringify({ evento: "Stop", sessao: "s-old", recebido_em: now - MAX_SPOOL_AGE_MS - 5000 }));
      fs.writeFileSync(
        staleStart,
        JSON.stringify({
          evento: "SessionStart",
          sessao: "s-stale",
          cwd: "C:/repo",
          recebido_em: now - MAX_SESSION_START_AGE_MS - 5000,
        }),
      );
      fs.writeFileSync(freshStop, JSON.stringify({ evento: "Stop", sessao: "s-fresh", recebido_em: now - 1000 }));

      const handled: HookEvent[] = [];
      const drainer = new SpoolDrainer(
        () => dir,
        async (ev) => {
          handled.push(ev);
        },
        () => now,
      );

      await Promise.all([drainer.drain(), drainer.drain()]);

      expect(handled).toHaveLength(1);
      expect(handled[0].sessao).toBe("s-fresh");
      expect(fs.readdirSync(dir)).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LM-14: Watcher health status and retry when folder is created later", () => {
  it("reports isActive() === false when folder does not exist and activates on retry", async () => {
    vi.useFakeTimers();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-lm14-"));
    const target = path.join(base, "not-yet-created");
    const handle = watchFolder(target, { onChange: () => {}, debounceMs: () => 50, retryMs: 200 });
    try {
      expect(handle.isActive()).toBe(false);
      fs.mkdirSync(target, { recursive: true });
      await vi.advanceTimersByTimeAsync(250);
      expect(handle.isActive()).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("LM-16: Compact tool responses without structuredContent duplication", () => {
  it("returns JSON in content[0].text with structuredContent undefined", async () => {
    const h = makeHarness();
    const prompter: ProjectPrompter = { confirmNewProject: async () => false };
    const creator = new ProjectCreator(h.vault, () => h.settings, () => undefined);
    const hooks = new HookHandler(h.engine, h.tracker, h.store, creator, prompter, () => h.settings);
    const tools = buildTools({
      engine: h.engine,
      locator: h.locator,
      tracker: h.tracker,
      store: h.store,
      hooks,
      settings: () => h.settings,
      runtime: () => ({ watching: true, hooksInstalled: true, connected: true }),
    });
    const statusTool = tools.find((t) => t.name === "logs_status")!;
    const res = await statusTool.handler({}, { client: { id: "test", name: "test" }, moduleId: "ai-log-manager" });
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toBeUndefined();
    const firstBlock = res.content[0];
    expect(firstBlock.type).toBe("text");
    if (firstBlock.type === "text") {
      expect(firstBlock.text).not.toContain("\n  ");
    }
  });
});

describe("LM-17 & LM-19: Node PATH check and declarative SettingDefinitions", () => {
  it("checkNodeInPath returns true in the test environment and SettingTab uses getSettingDefinitions()", async () => {
    await expect(checkNodeInPath()).resolves.toBe(true);

    const app = {} as unknown as App;
    const manifest: PluginManifest = { id: "ai-log-manager", name: "AI Log Manager", version: "0.4.0", minAppVersion: "1.5.0", description: "", author: "" };
    const plugin = new DummyPlugin(app, manifest);
    const host: SettingsHost = {
      settings: {
        mode: "active",
        claudeHome: "C:/Users/test/.claude",
        watch: true,
        debounceSeconds: 2,
        trackedFolders: [],
        projectsRoot: "Projetos",
        projectLogsFolder: "Logs",
      },
      saveSettings: async () => {},
      getConnectorStatus: () => ({ status: "connected" }),
      hooksInstalled: async () => false,
      nodeAvailable: async () => false,
      installHooks: async () => {},
      reconcileNow: async () => {},
    };

    const tab = new AILogManagerSettingTab(app, plugin, host);
    const defs = tab.getSettingDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(3);
    const groups = defs.filter((d) => "type" in d && d.type === "group");
    expect(groups.length).toBeGreaterThanOrEqual(3);

    const updateSpy = vi.spyOn(tab, "update");
    tab.refresh();
    expect(updateSpy).toHaveBeenCalledOnce();
  });
});

describe("LM-18: Deleted log note marks session as ignored and prevents automatic recreation", () => {
  it("does not recreate a deleted log note on syncAll, unless logs_set passes an explicit title", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Criar nota", T1) + assistantLine("Criada", T2), 1000);
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    expect(created.status).toBe("created");

    h.vault.notes.delete(created.notaLog!);
    h.engine.onNoteDeleted(created.notaLog!);
    expect(h.store.get("sess-1")?.apagadaPeloUsuario).toBe(true);
    expect(h.store.get("sess-1")?.ignorada).toBe(true);

    h.disk.append(h.transcript, userLine("Mais mensagens", T3) + assistantLine("Ok", T4), 2000);
    await h.engine.syncAll({ force: true, tzOffsetMinutes: -180 });
    const afterSync = await h.engine.syncTranscript(h.transcript, { force: true, tzOffsetMinutes: -180 });
    expect(afterSync.status).toBe("ignored");
    expect(h.vault.notes.size).toBe(0);

    const recreated = await h.engine.syncTranscript(h.transcript, { title: "Recriada explicitamente", tzOffsetMinutes: -180 });
    expect(recreated.status).toBe("created");
    expect(h.store.get("sess-1")?.apagadaPeloUsuario).toBeUndefined();
  });
});
