import { describe, expect, it } from "vitest";
import { resolveSourceFile } from "../../src/core/log-source-file";
import { copyPathFor } from "../../src/ui/log-menu";
import { describeLine } from "../../src/ui/jsonl-view";
import { assistantLine, makeHarness, userLine } from "../helpers/memory-ports";

const TZ = -180;
const T1 = "2026-10-21T15:00:00.000Z";
const T2 = "2026-10-21T15:01:00.000Z";

const sidechain = (line: string): string => JSON.stringify({ ...JSON.parse(line), isSidechain: true, agentId: "a1" }) + "\n";

describe("jsonl properties (KAN-2)", () => {
  it("writes jsonl and jsonl_caminho when the log is created", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Quero criar o plugin", T1) + assistantLine("Feito.", T2));
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const note = h.vault.notes.get(res.notaLog!)!;
    expect(note).toContain('jsonl: "sess-1.jsonl"');
    expect(note).toContain(`jsonl_caminho: ${JSON.stringify(h.transcript)}`);
  });

  it("adds the properties once to a log that already existed without them", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Quero criar o plugin", T1) + assistantLine("Feito.", T2));
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    // Simulates a log and checkpoint from before the feature.
    const cp = h.store.get("sess-1")!;
    h.store.set({ ...cp, jsonlRegistrado: undefined });
    h.vault.frontmatterEdits.length = 0;
    const again = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(again.status).toBe("unchanged");
    expect(h.vault.frontmatterEdits.some((e) => e.includes("jsonl_caminho"))).toBe(true);
    expect(res.notaLog).toBeDefined();
    h.vault.frontmatterEdits.length = 0;
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(h.vault.frontmatterEdits.some((e) => e.includes("jsonl_caminho"))).toBe(false);
  });
});

describe("subagent logs (KAN-1)", () => {
  function withSubagent(finished: boolean) {
    const h = makeHarness();
    const dir = h.transcript.replace(/\.jsonl$/, "");
    h.disk.put(h.transcript, userLine("Investigue o projeto", T1) + assistantLine("Delegando.", T2));
    h.disk.put(`${dir}/subagents/agent-a1.jsonl`, sidechain(userLine("Leia os arquivos X e Y", T1)) + sidechain(assistantLine("Li os dois: tudo certo.", T2)));
    h.disk.put(`${dir}/subagents/agent-a1.meta.json`, JSON.stringify({ agentType: "Explore", description: "Investigar código", model: "sonnet", finished }));
    return h;
  }

  it("creates a log for a finished subagent and links it from the parent", async () => {
    const h = withSubagent(true);
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const sub = [...h.vault.notes.keys()].find((k) => k.includes("/Subagentes/"));
    expect(sub).toBeDefined();
    const note = h.vault.notes.get(sub!)!;
    expect(note).toContain("  - subagente");
    expect(note).toContain("sessao: agent-a1");
    expect(note).toContain('sessao_pai: "sess-1"');
    expect(note).toContain('subagente_tipo: "Explore"');
    expect(note).toContain("**Solicitação:** Leia os arquivos X e Y");
    expect(note).toContain("**Resposta:** Li os dois: tudo certo.");
    expect(note).toContain('up: "[[21-10-2026 - 12h00 - Investigue o projeto]]"');
    expect(h.vault.frontmatterEdits.some((e) => e.includes("subagentes"))).toBe(true);
    expect(res.status).toBe("created");
  });

  it("does not write a log for a subagent that has not finished", async () => {
    const h = withSubagent(false);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect([...h.vault.notes.keys()].some((k) => k.includes("/Subagentes/"))).toBe(false);
  });

  it("does not duplicate the subagent log on the next sync", async () => {
    const h = withSubagent(true);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ, force: true });
    expect([...h.vault.notes.keys()].filter((k) => k.includes("/Subagentes/"))).toHaveLength(1);
  });
});

describe("resolveSourceFile (KAN-3 / KAN-4)", () => {
  const files = new Set(["C:/t/a.jsonl", "C:/g/conversations/abc.db", "C:/t/b.jsonl"]);
  const deps = {
    exists: (p: string) => Promise.resolve(files.has(p)),
    fromCheckpoint: (s: string) => (s === "host-1" ? "C:/t/b.jsonl" : undefined),
    findTranscript: (id: string) => Promise.resolve(id === "found" ? "C:/t/a.jsonl" : undefined),
    conversationFolders: () => ["C:/missing", "C:/g/conversations"],
  };

  it("uses the jsonl_caminho property first", async () => {
    expect(await resolveSourceFile({ agent: "claude", sessao: "x", transcript: "C:/t/a.jsonl" }, deps)).toEqual({ kind: "jsonl", path: "C:/t/a.jsonl" });
  });
  it("falls back to the checkpoint and then to a search by session id (local_ prefix removed)", async () => {
    expect((await resolveSourceFile({ agent: "claude", sessao: "host-1", transcript: undefined }, deps))?.path).toBe("C:/t/b.jsonl");
    expect((await resolveSourceFile({ agent: "claude", sessao: "local_found", transcript: undefined }, deps))?.path).toBe("C:/t/a.jsonl");
    expect(await resolveSourceFile({ agent: "claude", sessao: "nope", transcript: undefined }, deps)).toBeUndefined();
  });
  it("finds the Antigravity conversation database for gemini logs", async () => {
    expect(await resolveSourceFile({ agent: "gemini", sessao: "abc", transcript: undefined }, deps)).toEqual({ kind: "db", path: "C:/g/conversations/abc.db" });
  });
});

describe("log menu and jsonl view helpers", () => {
  it("names copies like Obsidian does", () => {
    const taken = new Set(["Logs/A 1.md"]);
    expect(copyPathFor((p) => taken.has(p), "Logs", "A", "md")).toBe("Logs/A 2.md");
    expect(copyPathFor(() => false, "/", "A", "md")).toBe("A 1.md");
  });
  it("describes transcript lines", () => {
    expect(describeLine({ type: "user", message: { content: "Oi  tudo bem" } })).toEqual({ type: "user", text: "Oi tudo bem" });
    expect(describeLine({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }).text).toBe("[Read]");
    expect(describeLine({ type: "custom-title", customTitle: "Meu título" }).text).toBe("Meu título");
  });
});

describe("groupLogs (KAN-1: subagent logs under the conversation)", () => {
  const rec = (name: string, date: number, extra: Partial<import("../../src/core/log-index").LogRecord> = {}): import("../../src/core/log-index").LogRecord => ({
    path: `${name}.md`, title: name, agent: "claude", project: undefined, status: "ativo", date, sessao: name, entries: [], mtime: date,
    transcript: undefined, subagent: false, name, parent: undefined, ...extra,
  });
  it("nests subagents under their parent, oldest first, and keeps orphans on their own", async () => {
    const { groupLogs } = await import("../../src/core/log-index");
    const parent = rec("P", 100);
    const a = rec("A", 90, { subagent: true, parent: "P" });
    const b = rec("B", 80, { subagent: true, parent: "P" });
    const orphan = rec("O", 70, { subagent: true, parent: "Missing" });
    const groups = groupLogs([parent, a, b, orphan], [parent, a, b, orphan]);
    expect(groups.map((g) => g.record.name)).toEqual(["P", "O"]);
    expect(groups[0]!.children.map((c) => c.name)).toEqual(["B", "A"]);
  });
  it("lists the parent when only a subagent matched the filters", async () => {
    const { groupLogs } = await import("../../src/core/log-index");
    const parent = rec("P", 100);
    const a = rec("A", 90, { subagent: true, parent: "P" });
    const groups = groupLogs([a], [parent, a]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.record.name).toBe("P");
    expect(groups[0]!.children).toHaveLength(1);
  });
});
