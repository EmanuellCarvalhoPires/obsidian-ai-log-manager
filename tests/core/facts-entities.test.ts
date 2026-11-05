import { describe, expect, it } from "vitest";
import { buildIndex } from "../../src/core/log-index";
import type { LogSource } from "../../src/core/log-index";
import { appendEntries, appendFacts, buildNoteContent, extractEntitiesFromTurns, parseTicketPrefixes } from "../../src/core/log-note";
import type { Entry } from "../../src/core/format";
import { assistantLine, makeHarness, userLine } from "../helpers/memory-ports";

const entry = (stamp: string, title: string): Entry => ({
  heading: `${stamp} - ${title}`,
  summaryLink: `- [[#${stamp} - ${title}|${stamp} - ${title}]]`,
  markdown: `## ${stamp} - ${title}\n\n**Solicitação:** ${title}\n`,
});

const base = (): string =>
  buildNoteContent({ agent: "claude", hostSessionId: "h1", title: "T", up: ["Memória Claude"] }, [entry("21/10/2026 - 12:00", "Primeiro")]);

const turn = (stamp: string) => ({ timestamp: stamp });

describe("appendFacts", () => {
  it("creates the section between the Sumário and the rule, with a timestamp", () => {
    const res = appendFacts(base(), ["Definido uso de RRF"], "05/11/2026 14:30");
    expect(res.added).toBe(1);
    const c = res.content;
    expect(c).toContain("## Decisões e Fatos da Sessão\n- [05/11/2026 14:30] Definido uso de RRF\n\n---");
    expect(c.indexOf("## Sumário")).toBeLessThan(c.indexOf("## Decisões e Fatos da Sessão"));
    expect(c.indexOf("## Decisões e Fatos da Sessão")).toBeLessThan(c.indexOf("\n---", c.indexOf("## Sumário")));
    expect(c).toContain("## 21/10/2026 - 12:00 - Primeiro");
  });

  it("appends to an existing section and skips exact duplicates", () => {
    const once = appendFacts(base(), ["A"], "05/11/2026 14:30").content;
    const twice = appendFacts(once, ["A", "B"], "05/11/2026 15:00");
    expect(twice.added).toBe(1);
    expect(twice.content.match(/\] A\n/g)).toHaveLength(1);
    expect(twice.content).toContain("- [05/11/2026 15:00] B");
    expect(appendFacts(twice.content, ["B"], "x").added).toBe(0);
  });

  it("does nothing without facts or without a Sumário", () => {
    expect(appendFacts(base(), ["  "], "t").added).toBe(0);
    expect(appendFacts("# sem sumário", ["a"], "t").added).toBe(0);
  });

  it("writes initial facts when the note is created", () => {
    const c = buildNoteContent(
      { agent: "claude", hostSessionId: "h", title: "T", up: ["Memória Claude"], fatos: ["Fato inicial"], factsTimestamp: "05/11/2026 10:00" },
      [entry("21/10/2026 - 12:00", "Primeiro")],
    );
    expect(c).toContain("- [05/11/2026 10:00] Fato inicial");
  });
});

describe("appendFacts and appendEntries interleaved", () => {
  const sumarioOf = (c: string): string => /## Sumário\n([\s\S]*?)\n(?:---|## )/.exec(c)![1]!;

  it("keeps working without the section", () => {
    const res = appendEntries(base(), [turn("21/10/2026 - 12:00"), turn("21/10/2026 - 12:05")], (i) => entry("21/10/2026 - 12:05", `N${i}`));
    expect(res.added).toBe(1);
    expect(sumarioOf(res.content)).toContain("12:05");
    expect(res.content.trimEnd().endsWith("**Solicitação:** N1")).toBe(true);
  });

  it("puts new Sumário lines in the Sumário, not in the facts section", () => {
    const withFacts = appendFacts(base(), ["Decisão X"], "05/11/2026 14:30").content;
    const res = appendEntries(withFacts, [turn("21/10/2026 - 12:00"), turn("21/10/2026 - 12:05")], () => entry("21/10/2026 - 12:05", "Segundo"));
    expect(res.added).toBe(1);
    const c = res.content;
    const sumario = sumarioOf(c);
    expect(sumario).toContain("12:00");
    expect(sumario).toContain("12:05");
    expect(sumario).not.toContain("Decisão X");
    expect(c.indexOf("12:05|")).toBeLessThan(c.indexOf("## Decisões e Fatos da Sessão"));
    expect(c).toContain("## Decisões e Fatos da Sessão\n- [05/11/2026 14:30] Decisão X\n\n---");
    expect(c.trimEnd().endsWith("**Solicitação:** Segundo")).toBe(true);
  });

  it("adds facts after entries were appended", () => {
    const afterEntries = appendEntries(base(), [turn("21/10/2026 - 12:00"), turn("21/10/2026 - 12:05")], () => entry("21/10/2026 - 12:05", "Segundo")).content;
    const res = appendFacts(afterEntries, ["Depois"], "05/11/2026 14:30");
    expect(res.added).toBe(1);
    const c = res.content;
    expect(c.indexOf("## Decisões e Fatos da Sessão")).toBeLessThan(c.indexOf("\n---", c.indexOf("## Sumário")));
    expect(c).toContain("## 21/10/2026 - 12:05 - Segundo");
    const again = appendEntries(c, [turn("21/10/2026 - 12:00"), turn("21/10/2026 - 12:05"), turn("21/10/2026 - 12:10")], (i) => entry("21/10/2026 - 12:10", `T${i}`));
    expect(again.added).toBe(1);
    expect(sumarioOf(again.content)).toContain("12:10");
  });
});

describe("entity extraction", () => {
  const turns = [
    {
      userText: "Vamos tratar o DEVAT-45 e o PR #36 no Clonador de Projetos",
      assistantTexts: ["Ok. UTF-8, SHA-256 e ISO-8601 não contam; GPT-4 também não. Ver ATL-437 e PR#7."],
    },
  ];
  const prefixes = new Set(["DEVAT", "ATL"]);

  it("validates tickets against the real prefixes", () => {
    const e = extractEntitiesFromTurns(turns, ["Clonador de Projetos", "Outro"], prefixes);
    expect(e.tickets).toEqual(["DEVAT-45", "ATL-437"]);
    expect(e.prs).toEqual(["PR #36", "PR #7"]);
    expect(e.projects).toEqual(["Clonador de Projetos"]);
  });

  it("falls back to regex plus the exclusion list without prefixes", () => {
    const e = extractEntitiesFromTurns(turns, [], undefined);
    expect(e.tickets).toEqual(["DEVAT-45", "ATL-437"]);
    expect(e.tickets).not.toContain("UTF-8");
  });

  it("parses the prefixes note tables", () => {
    const set = parseTicketPrefixes("| Prefixo | Projeto |\n| --- | --- |\n| `ATL` | Agile |\n| `DEVAT` | Dev |\n| `A5X` | x |");
    expect([...set].sort()).toEqual(["A5X", "ATL", "DEVAT"]);
  });
});

describe("engine: entities and facts", () => {
  const T1 = "2026-10-21T15:00:00.000Z";
  const T2 = "2026-10-21T15:01:00.000Z";
  const T3 = "2026-10-21T15:05:00.000Z";
  const T4 = "2026-10-21T15:06:00.000Z";

  it("fills the entity properties on creation, validating by the vault prefixes note", async () => {
    const h = makeHarness();
    h.vault.projectList = [{ name: "Clonador de Projetos", folder: "Projetos/Clonador", clonePath: undefined }];
    h.vault.notes.set("MCP/Prefixos de Projetos Jira.md", "| `DEVAT` | x |\n| `ATL` | y |");
    h.disk.put(h.transcript, userLine("Trabalhar no DEVAT-45, PR #36, GPT-4 e Clonador de Projetos", T1) + assistantLine("Feito.", T2));
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    const note = h.vault.notes.get(res.notaLog!)!;
    expect(note).toContain("tickets_citados:\n  - DEVAT-45");
    expect(note).not.toContain("GPT-4\n");
    expect(note).toContain('prs_citados:\n  - "PR #36"');
    expect(note).toContain('projetos_citados:\n  - "[[Clonador de Projetos]]"');
  });

  it("merges entities into the frontmatter of an existing log without duplicates", async () => {
    const h = makeHarness();
    h.vault.notes.set("MCP/Prefixos de Projetos Jira.md", "| `DEVAT` | x |");
    h.disk.put(h.transcript, userLine("Primeiro DEVAT-45", T1) + assistantLine("ok", T2), 1000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    h.disk.append(h.transcript, userLine("Agora DEVAT-46", T3) + assistantLine("ok", T4), 2000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    const last = JSON.parse(h.vault.frontmatterEdits.at(-1)!) as Record<string, string[]>;
    expect(last.tickets_citados).toEqual(["DEVAT-45", "DEVAT-46"]);
  });

  it("addFacts writes the section and keeps later entries working", async () => {
    const h = makeHarness();
    h.disk.put(h.transcript, userLine("Primeiro", T1) + assistantLine("ok", T2), 1000);
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    const res = await h.engine.addFacts("sess-1", ["Definido uso de RRF no motor de busca"]);
    expect(res).toMatchObject({ updated: true, added: 1, notaLog: created.notaLog });
    expect(h.vault.notes.get(created.notaLog!)).toMatch(/## Decisões e Fatos da Sessão\n- \[\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\] Definido uso de RRF/);

    h.disk.append(h.transcript, userLine("Segundo", T3) + assistantLine("ok", T4), 2000);
    const next = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: -180 });
    expect(next.added).toBe(1);
    const note = h.vault.notes.get(created.notaLog!)!;
    expect(note.indexOf("12:05 - Segundo|")).toBeLessThan(note.indexOf("## Decisões e Fatos da Sessão"));
    expect((await h.engine.addFacts("sess-1", ["Definido uso de RRF no motor de busca"])).added).toBe(0);
  });

  it("addFacts fails when the log does not exist", async () => {
    const h = makeHarness();
    await expect(h.engine.addFacts("nada", ["x"])).rejects.toThrow(/no log/);
  });
});

describe("log index", () => {
  it("does not list the facts section as an entry", () => {
    const src: LogSource = {
      path: "a.md",
      basename: "21-10-2026 - 12h00 - X",
      tags: ["log", "claude"],
      frontmatter: {},
      headings: ["Sumário", "Decisões e Fatos da Sessão", "21/10/2026 - 12:00 - Primeiro"],
      ctime: 1,
      mtime: 2,
    };
    expect(buildIndex([src])[0]!.entries).toEqual(["21/10/2026 - 12:00 - Primeiro"]);
  });
});
