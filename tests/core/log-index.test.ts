import { describe, expect, it } from "vitest";
import { buildIndex, dateFromName, distinct, filterLogs, unwikilink } from "../../src/core/log-index";
import type { LogSource } from "../../src/core/log-index";

const src = (over: Partial<LogSource>): LogSource => ({
  path: "Knowledge/Logs/x.md",
  basename: "21-10-2026 - 12h00 - Plugin de logs",
  tags: ["#log", "#claude", "#sessao/ativo"],
  frontmatter: { sessao: "local_1" },
  headings: ["Sumário", "21/10/2026 - 12:00 - Primeiro", "21/10/2026 - 12:05 - Segundo"],
  ctime: 1,
  mtime: 2,
  ...over,
});

describe("log index", () => {
  it("indexes Claude and Antigravity logs and skips other notes", () => {
    const idx = buildIndex([
      src({}),
      src({ path: "g.md", basename: "20-10-2026 - 09h00 - Gemini", tags: ["log", "gemini", "sessao/arquivado"] }),
      src({ path: "n.md", tags: ["moc"] }),
    ]);
    expect(idx.map((r) => [r.agent, r.status])).toEqual([
      ["claude", "ativo"],
      ["gemini", "arquivado"],
    ]);
    expect(idx[0]!.title).toBe("Plugin de logs");
    expect(idx[0]!.entries).toHaveLength(2);
    expect(idx[0]!.date).toBe(new Date(2026, 9, 21, 12, 5).getTime());
  });

  it("reads project from the frontmatter and falls back to ctime for the date", () => {
    const [r] = buildIndex([src({ basename: "sem data", headings: ["Sumário"], frontmatter: { projeto: "[[Meu App]]" }, ctime: 99 })]);
    expect(r!.project).toBe("Meu App");
    expect(r!.date).toBe(99);
    expect(unwikilink("[[A|b]]")).toBe("A");
    expect(dateFromName("nada")).toBeUndefined();
  });

  it("filters by agent, project, status, date and accent-insensitive search", () => {
    const idx = buildIndex([
      src({ frontmatter: { projeto: "[[App]]" } }),
      src({ path: "g.md", basename: "01-10-2026 - 09h00 - Revisão do Gemini", tags: ["log", "gemini", "sessao/arquivado"], headings: ["01/10/2026 - 09:00 - Outro"] }),
    ]);
    expect(filterLogs(idx, { agent: "gemini" })).toHaveLength(1);
    expect(filterLogs(idx, { project: "App" })).toHaveLength(1);
    expect(filterLogs(idx, { status: "arquivado" })[0]!.agent).toBe("gemini");
    expect(filterLogs(idx, { from: new Date(2026, 9, 15).getTime() })).toHaveLength(1);
    expect(filterLogs(idx, { to: new Date(2026, 9, 15).getTime() })).toHaveLength(1);
    expect(filterLogs(idx, { query: "revisao gemini" })).toHaveLength(1);
    expect(filterLogs(idx, { query: "segundo" })).toHaveLength(1);
    expect(filterLogs(idx, { query: "inexistente" })).toHaveLength(0);
    expect(distinct(idx, (r) => r.project)).toEqual(["App"]);
  });
});
