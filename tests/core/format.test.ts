import { describe, expect, it } from "vitest";
import { buildEntry, cleanHeadingTitle, formatSolicitacao, generateEntryTitle } from "../../src/core/format";
import type { Turn } from "../../src/core/transcript";

function turn(over: Partial<Turn>): Turn {
  return {
    timestamp: "21/10/2026 - 12:00",
    date: new Date("2026-10-21T15:00:00.000Z"),
    userText: "",
    rawText: "",
    imagesCount: 0,
    tools: [],
    filesModified: [],
    commands: [],
    assistantTexts: [],
    complete: true,
    ...over,
  } as unknown as Turn;
}

describe("entry headings", () => {
  it("does not capture the closing quote of an obsidian link and keeps the heading clean", () => {
    const raw = 'Veja "obsidian://open?vault=Cofre&file=Nota%20X" por favor';
    const t = turn({ userText: raw, rawText: raw });
    expect(generateEntryTitle(t)).toBe("Link da nota [[Nota X]]");
    const entry = buildEntry(t);
    expect(entry.heading).toBe("21/10/2026 - 12:00 - Link da nota Nota X");
    expect(entry.summaryLink).toBe("- [[#21/10/2026 - 12:00 - Link da nota Nota X|21/10/2026 - 12:00 - Link da nota Nota X]]");
    expect(entry.markdown).toContain("## 21/10/2026 - 12:00 - Link da nota Nota X");
    expect(formatSolicitacao(t)).toContain("[[Nota X]]");
    expect(formatSolicitacao(t)).not.toContain('Nota X"');
  });

  it("cuts the sentence only at a period followed by a space", () => {
    const t = turn({ userText: "Atualiza o CLAUDE.md do projeto agora" });
    expect(generateEntryTitle(t)).toBe("Atualiza o CLAUDE.md do projeto agora");
    expect(generateEntryTitle(turn({ userText: "Corrige isso. Depois o resto" }))).toBe("Corrige isso");
  });

  it("cleanHeadingTitle removes wikilink brackets, pipes, hashes and carets", () => {
    expect(cleanHeadingTitle("Link [[Nota|apelido]] e [[Outra]]")).toBe("Link Nota e Outra");
    expect(cleanHeadingTitle("a | b # c ^ d")).toBe("a b c d");
  });
});
