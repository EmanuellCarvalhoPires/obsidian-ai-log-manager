import { describe, expect, it } from "vitest";
import { assistantLine, makeHarness, toolResultLine, toolUseLine, userLine } from "../helpers/memory-ports";

const TZ = -180; // UTC-3, like the old script
const T1 = "2026-10-21T15:00:00.000Z"; // 12:00 local
const T2 = "2026-10-21T15:01:00.000Z";
const T3 = "2026-10-21T15:05:00.000Z";
const T4 = "2026-10-21T15:06:00.000Z";

function firstTurns(): string {
  return userLine("Quero criar o plugin de logs", T1) + assistantLine("Vou começar pelo motor.", T2);
}

describe("LogEngine", () => {
  it("creates the log by itself with an automatic title and one entry", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, firstTurns());
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("created");
    expect(res.added).toBe(1);
    expect(res.notaLog).toBe("Knowledge/Logs/21-10-2026 - 12h00 - Quero criar o plugin de logs.md");
    const note = h.vault.notes.get(res.notaLog!)!;
    expect(note).toContain("sessao: local_sess-1");
    expect(note).toContain("  - sessao/ativo");
    expect(note).toContain("up: \"[[Memória Claude]]\"");
    expect(note).toContain("## 21/10/2026 - 12:00 - Quero criar o plugin de logs");
    expect(note).toContain("**Solicitação:** Quero criar o plugin de logs");
    expect(note).toContain("**Resposta:** Vou começar pelo motor.");
  });

  it("appends only the new entry and never changes existing content", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, firstTurns(), 1000);
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const before = h.vault.notes.get(created.notaLog!)!;

    h.disk.append(h.transcript, userLine("Agora o watcher", T3) + assistantLine("Feito.", T4), 2000);
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("updated");
    expect(res.added).toBe(1);
    const after = h.vault.notes.get(created.notaLog!)!;
    expect(after.startsWith(before.split("## Sumário")[0]!)).toBe(true);
    expect(after).toContain("- [[#21/10/2026 - 12:05 - Agora o watcher|21/10/2026 - 12:05 - Agora o watcher]]");
    expect(after.indexOf("## 21/10/2026 - 12:00")).toBeLessThan(after.indexOf("## 21/10/2026 - 12:05"));
    // the old record is byte-for-byte still there
    expect(after).toContain(before.slice(before.indexOf("## 21/10/2026 - 12:00")));
  });

  it("is idempotent: syncing twice, or forcing, adds nothing", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, firstTurns());
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const snapshot = [...h.vault.notes.values()][0];
    expect((await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ })).status).toBe("unchanged");
    const forced = await h.engine.syncTranscript(h.transcript, { force: true, tzOffsetMinutes: TZ });
    expect(forced.added).toBe(0);
    expect([...h.vault.notes.values()][0]).toBe(snapshot);
    expect(h.vault.notes.size).toBe(1);
  });

  it("does not write a turn the assistant has not finished", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Faz algo longo", T1) + toolUseLine("Bash", { command: "npm test" }, T2) + toolResultLine(T2));
    expect((await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ })).status).toBe("pending");
    expect(h.vault.notes.size).toBe(0);
    h.disk.append(h.transcript, assistantLine("Terminei.", T3), 2000);
    expect((await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ })).status).toBe("created");
  });

  it("writes the unfinished turn when the session ends (flush)", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Interrompido", T1) + toolUseLine("Bash", { command: "ls" }, T2));
    const res = await h.engine.syncTranscript(h.transcript, { flush: true, tzOffsetMinutes: TZ });
    expect(res.status).toBe("created");
  });

  it("adopts a log that already exists (created by the old script) without duplicating", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, firstTurns());
    const existing = [
      "---",
      "tags:",
      "  - log",
      "  - claude",
      "  - sessao/ativo",
      'up: "[[Memória Claude]]"',
      "sessao: local_sess-1",
      "Status da Sessão: Ativo",
      "---",
      "# Título do script",
      "",
      "## Sumário",
      "- [[#21/10/2026 - 12:00 - Quero criar o plugin de logs|x]]",
      "",
      "---",
      "",
      "## 21/10/2026 - 12:00 - Quero criar o plugin de logs",
      "",
      "**Solicitação:** a",
      "",
      "**Resposta:** b",
      "",
    ].join("\n");
    h.vault.notes.set("Knowledge/Logs/antigo.md", existing);
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("unchanged");
    expect(h.vault.notes.size).toBe(1);
    expect(h.vault.notes.get("Knowledge/Logs/antigo.md")).toBe(existing);
  });

  it("uses the hostSessionId of the session file as the sessao property", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, firstTurns());
    h.disk.put("C:/home/.claude/sessions/1.json", JSON.stringify({ sessionId: "sess-1", hostSessionId: "local_host-9", name: "Meu nome", nameSource: "user" }));
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const note = h.vault.notes.get(res.notaLog!)!;
    expect(note).toContain("sessao: local_host-9");
    expect(note).toContain("# Meu nome");
  });

  it("keeps multi-session logs apart", async () => {
    const h = makeHarness();
    const t2 = "C:/home/.claude/projects/proj/sess-2.jsonl";
    h.disk.put(h.transcript, firstTurns());
    h.disk.put(t2, userLine("Outra conversa", T3).replace("sess-1", "sess-2") + assistantLine("Ok.", T4));
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    await h.engine.syncTranscript(t2, { tzOffsetMinutes: TZ });
    expect(h.vault.notes.size).toBe(2);
    const sessions = [...h.vault.notes.values()].map((n) => /^sessao: (.+)$/m.exec(n)![1]);
    expect(new Set(sessions).size).toBe(2);
  });

  it("serializes concurrent triggers of the same session (watcher + hook)", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, firstTurns());
    const results = await Promise.all([
      h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ }),
      h.engine.syncTranscript(h.transcript, { flush: true, tzOffsetMinutes: TZ }),
      h.engine.syncSession("sess-1", { force: true, tzOffsetMinutes: TZ }),
    ]);
    expect(h.vault.notes.size).toBe(1);
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    const note = [...h.vault.notes.values()][0]!;
    expect(note.match(/^## 21\/10\/2026 - 12:00/gm)).toHaveLength(1);
  });

  it("logs short confirmations like 'sim' as normal entries", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Quero uma tela de logs", T1) + assistantLine("Posso criar?", T2) + userLine("sim", T3) + assistantLine("Criada.", T4));
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const note = h.vault.notes.get(res.notaLog!)!;
    expect(note.match(/^## \d{2}\//gm)).toHaveLength(2);
    expect(note).toContain("**Solicitação:** sim");
  });

  it("ignores conversations outside the tracked folders", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Oi", T1, "C:/Outra/Pasta") + assistantLine("Olá.", T2));
    expect((await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ })).status).toBe("ignored");
    expect(h.vault.notes.size).toBe(0);
  });

  it("tracks conversations of a configured folder", async () => {
    const h = makeHarness({ trackedFolders: ["C:/Dev"] });
    h.disk.put(h.transcript, userLine("Oi", T1, "C:/Dev/app") + assistantLine("Olá.", T2));
    expect((await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ })).status).toBe("created");
  });

  it("puts a project conversation in the project Logs folder with a double up", async () => {
    const h = makeHarness();
    h.vault.projectList = [{ name: "Meu App", folder: "Projetos/Meu App", clonePath: "C:/Dev/meu-app" }];
    h.disk.put(h.transcript, userLine("Corrige o bug", T1, "C:/Dev/meu-app/src") + assistantLine("Corrigido.", T2));
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(res.notaLog).toBe("Projetos/Meu App/Logs/21-10-2026 - 12h00 - Corrige o bug.md");
    const note = h.vault.notes.get(res.notaLog!)!;
    expect(note).toContain('  - "[[Memória Claude]]"');
    expect(note).toContain('  - "[[Meu App - Logs]]"');
    expect(note).toContain('projeto: "[[Meu App]]"');
  });

  it("observe mode reports what it would do and writes nothing", async () => {
    const h = makeHarness({ mode: "observe" });
    h.disk.put(h.transcript, firstTurns());
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("observed");
    expect(res.added).toBe(1);
    expect(h.vault.notes.size).toBe(0);
  });

  it("reconciles on open only what changed after the last checkpoint", async () => {
    const h = makeHarness();
    const old = "C:/home/.claude/projects/proj/old.jsonl";
    h.disk.put(old, userLine("Antiga", T1).replace("sess-1", "old") + assistantLine("Ok.", T2), 1000);
    h.disk.put(h.transcript, firstTurns(), 9000); // changed while Obsidian was closed
    const results = await h.engine.syncAll({ since: 5000, tzOffsetMinutes: TZ });
    expect(results.map((r) => r.sessao)).toEqual(["sess-1"]);
    expect(h.vault.notes.size).toBe(1);
  });

  it("completes a log with the entries missed while Obsidian was closed", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, firstTurns(), 1000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    h.disk.append(h.transcript, userLine("B", T3) + assistantLine("b", T4) + userLine("C", "2026-10-21T16:00:00.000Z") + assistantLine("c", "2026-10-21T16:01:00.000Z"), 9000);
    const results = await h.engine.syncAll({ since: 5000, tzOffsetMinutes: TZ });
    expect(results[0]?.added).toBe(2);
    expect([...h.vault.notes.values()][0]!.match(/^## \d{2}\//gm)).toHaveLength(3);
  });

  it("links a log to a project, and remembers the link before the log exists", async () => {
    const h = makeHarness();
    h.vault.projectList = [{ name: "Meu App", folder: "Projetos/Meu App", clonePath: undefined }];
    h.disk.put(h.transcript, firstTurns());
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const linked = await h.engine.linkProject("sess-1", h.vault.projectList[0]!, ["Meu App - feature-x"]);
    expect(linked.linked).toBe(true);
    const fm = JSON.parse(h.vault.frontmatterEdits[0]!) as { up: string[]; projeto: string; branches: string[] };
    expect(fm.up).toContain("[[Meu App - Logs]]");
    expect(fm.projeto).toBe("[[Meu App]]");
    expect(fm.branches).toEqual(["[[Meu App - feature-x]]"]);
    expect(created.notaLog).toBeDefined();
  });

  it("renames the log (file and heading)", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, firstTurns());
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const renamed = await h.engine.rename("sess-1", "Plugin de logs - motor");
    expect(renamed.notaLog).toBe("Knowledge/Logs/21-10-2026 - 12h00 - Plugin de logs - motor.md");
    expect(h.vault.notes.has(created.notaLog!)).toBe(false);
    expect(h.vault.notes.get(renamed.notaLog)).toContain("# Plugin de logs - motor");
  });

  it("keeps the title chosen before the log exists and uses it when the log is created", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Faz algo longo", T1) + toolUseLine("Bash", { command: "npm test" }, T2), 1000);
    const pending = await h.engine.syncTranscript(h.transcript, { force: true, title: "Título escolhido", tzOffsetMinutes: TZ });
    expect(pending.status).toBe("pending");
    expect(h.vault.notes.size).toBe(0);
    h.disk.append(h.transcript, assistantLine("Terminei.", T3), 2000);
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(created.status).toBe("created");
    expect(created.notaLog).toBe("Knowledge/Logs/21-10-2026 - 12h00 - Título escolhido.md");
    expect(h.vault.notes.get(created.notaLog!)).toContain("# Título escolhido");
    expect(h.store.get("sess-1")?.tituloPendente).toBeUndefined();
  });

  it("keeps the branches chosen before the log exists and writes them when the log is created", async () => {
    const h = makeHarness();
    h.vault.projectList = [{ name: "Meu App", folder: "Projetos/Meu App", clonePath: undefined }];
    await h.engine.linkProject("sess-1", h.vault.projectList[0]!, ["Meu App - feature-x"], h.transcript);
    h.disk.put(h.transcript, firstTurns());
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(created.status).toBe("created");
    const note = h.vault.notes.get(created.notaLog!)!;
    expect(note).toContain("branches:");
    expect(note).toContain('  - "[[Meu App - feature-x]]"');
    expect(note).toContain('projeto: "[[Meu App]]"');
    expect(h.store.get("sess-1")?.branchesPendentes).toBeUndefined();
  });
});
