import { describe, expect, it } from "vitest";
import { buildIndex, forkRootOf, groupLogs, toRecord } from "../../src/core/log-index";
import type { LogRecord, LogSource } from "../../src/core/log-index";
import { forkParentOf, parseTranscript } from "../../src/core/transcript";
import { assistantLine, makeHarness, userLine } from "../helpers/memory-ports";
import type { Harness } from "../helpers/memory-ports";

const TZ = -180;
const T1 = "2026-10-21T15:00:00.000Z";
const T2 = "2026-10-21T15:01:00.000Z";
const T3 = "2026-10-21T16:00:00.000Z";
const T4 = "2026-10-21T16:01:00.000Z";

/** The same transcript line, written by another session id (how a fork keeps the lines it copied). */
const as = (line: string, sessionId: string): string => JSON.stringify({ ...JSON.parse(line), sessionId }) + "\n";

describe("forkParentOf (KAN-10)", () => {
  it("is the id seen right before the first line of the transcript's own session", () => {
    expect(forkParentOf(["a", "b", "own"], "own")).toBe("b");
    expect(forkParentOf(["own"], "own")).toBeUndefined();
    expect(forkParentOf(["a"], "own")).toBeUndefined();
    expect(forkParentOf([], "own")).toBeUndefined();
  });

  it("collects the session ids of a transcript in order, ignoring sidechain lines", () => {
    const text =
      as(userLine("Oi", T1), "parent") +
      as(assistantLine("Olá", T2), "parent") +
      as(userLine("Seguindo", T3), "own") +
      JSON.stringify({ ...JSON.parse(userLine("Interno", T3)), sessionId: "other", isSidechain: true }) +
      "\n";
    expect(parseTranscript(text).sessionIds).toEqual(["parent", "own"]);
  });
});

describe("log of a fork (KAN-10)", () => {
  /** A parent conversation (sess-0) already logged, and the transcript of a fork of it (sess-1). */
  async function withFork(): Promise<{ h: Harness; parentNote: string; forkNote: string }> {
    const h = makeHarness();
    const parentTranscript = h.transcript.replace("sess-1", "sess-0");
    h.disk.put(parentTranscript, as(userLine("Conversa original", T1), "sess-0") + as(assistantLine("Resposta original.", T2), "sess-0"));
    const parent = await h.engine.syncTranscript(parentTranscript, { tzOffsetMinutes: TZ });
    h.disk.put(
      h.transcript,
      as(userLine("Conversa original", T1), "sess-0") +
        as(assistantLine("Resposta original.", T2), "sess-0") +
        as(userLine("Seguindo por outro caminho", T3), "sess-1") +
        as(assistantLine("Certo, outro caminho.", T4), "sess-1"),
    );
    const fork = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    return { h, parentNote: parent.notaLog!, forkNote: fork.notaLog! };
  }

  it("tags the new log `fork` and records the conversation it came from", async () => {
    const { h, parentNote, forkNote } = await withFork();
    const note = h.vault.notes.get(forkNote)!;
    expect(note).toContain("  - fork");
    expect(note).not.toContain("  - subagente");
    expect(note).toContain('sessao_pai: "sess-0"');
    const parentName = parentNote.replace(/^.*\//, "").replace(/\.md$/, "");
    expect(note).toContain(`fork_de: "[[${parentName}]]"`);
  });

  it("does not mark a conversation that was not forked", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Quero criar o plugin", T1) + assistantLine("Feito.", T2));
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const note = h.vault.notes.get(res.notaLog!)!;
    expect(note).not.toContain("  - fork");
    expect(note).not.toContain("sessao_pai");
  });

  it("gives the fork properties once to a fork log made before the feature", async () => {
    const { h, forkNote } = await withFork();
    // A log and checkpoint from before KAN-10: no fork mark yet.
    h.store.set({ ...h.store.get("sess-1")!, forkRegistrado: undefined });
    h.vault.frontmatterEdits.length = 0;
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ, force: true });
    expect(h.vault.frontmatterEdits.some((e) => e.includes('"sessao_pai":"sess-0"') && e.includes('"tags":["fork"]'))).toBe(true);
    expect(h.vault.notes.has(forkNote)).toBe(true);
    h.vault.frontmatterEdits.length = 0;
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ, force: true });
    expect(h.vault.frontmatterEdits.some((e) => e.includes("sessao_pai"))).toBe(false);
  });
});

describe("fork logs in the index (KAN-10)", () => {
  const source = (name: string, tags: string[], frontmatter: Record<string, unknown>): LogSource => ({
    path: `Logs/${name}.md`,
    basename: name,
    tags,
    frontmatter,
    headings: [],
    ctime: 1,
    mtime: 1,
  });

  it("reads the fork tag and the parent session from the note", () => {
    const fork = toRecord(source("F", ["log", "claude", "fork", "sessao/ativo"], { sessao: "local_f", sessao_pai: "p" }))!;
    expect(fork.fork).toBe(true);
    expect(fork.forkOf).toBe("p");
    expect(fork.subagent).toBe(false);
    const plain = toRecord(source("P", ["log", "claude", "sessao/ativo"], { sessao: "local_p" }))!;
    expect(plain.fork).toBe(false);
    expect(plain.forkOf).toBeUndefined();
    expect(buildIndex([source("F", ["log", "claude", "fork"], {}), source("P", ["log", "claude"], {})])).toHaveLength(2);
  });

  const rec = (name: string, date: number, extra: Partial<LogRecord> = {}): LogRecord => ({
    path: `${name}.md`,
    title: name,
    agent: "claude",
    project: undefined,
    status: "ativo",
    date,
    sessao: `local_${name}`,
    entries: [],
    mtime: date,
    transcript: undefined,
    subagent: false,
    name,
    parent: undefined,
    ...extra,
  });

  it("nests forks under their parent in a group apart from the subagents", () => {
    const parent = rec("P", 100);
    const sub = rec("S", 90, { subagent: true, parent: "P", sessao: "agent-s" });
    const f2 = rec("F2", 80, { fork: true, forkOf: "P" });
    const f1 = rec("F1", 70, { fork: true, forkOf: "local_P" });
    const all = [parent, sub, f2, f1];
    const groups = groupLogs(all, all);
    expect(groups.map((g) => g.record.name)).toEqual(["P"]);
    expect(groups[0]!.children.map((c) => c.name)).toEqual(["S"]);
    expect(groups[0]!.forks.map((c) => c.name)).toEqual(["F1", "F2"]);
  });

  it("keeps a fork whose parent log is unknown on its own, and lists the parent when only a fork matched", () => {
    const parent = rec("P", 100);
    const orphan = rec("O", 90, { fork: true, forkOf: "missing" });
    const noParent = rec("N", 85, { fork: true, forkOf: undefined });
    const f = rec("F", 80, { fork: true, forkOf: "P" });
    const groups = groupLogs([orphan, noParent, f], [parent, orphan, noParent, f]);
    expect(groups.map((g) => g.record.name)).toEqual(["O", "N", "P"]);
    expect(groups[2]!.forks.map((c) => c.name)).toEqual(["F"]);
    expect(groups[2]!.children).toHaveLength(0);
  });

  it("lists a fork of a fork under the conversation at the root of the chain", () => {
    const parent = rec("P", 100);
    const f1 = rec("F1", 90, { fork: true, forkOf: "P" });
    const f2 = rec("F2", 80, { fork: true, forkOf: "F1" });
    const all = [parent, f1, f2];
    const groups = groupLogs(all, all);
    expect(groups.map((g) => g.record.name)).toEqual(["P"]);
    expect(groups[0]!.forks.map((c) => c.name)).toEqual(["F2", "F1"]);
    expect(forkRootOf(f2, all)?.name).toBe("P");
    expect(forkRootOf(parent, all)).toBeUndefined();
  });

  it("does not loop when two forks point at each other", () => {
    const a = rec("A", 90, { fork: true, forkOf: "B" });
    const b = rec("B", 80, { fork: true, forkOf: "A" });
    const groups = groupLogs([a, b], [a, b]);
    expect(groups.map((g) => g.record.name)).toEqual(["A", "B"]);
  });
});
