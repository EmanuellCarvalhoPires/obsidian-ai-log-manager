// Premise 1 of the plan: the transcript format is the one the old script reads, and the plugin
// writes the same entries. Runs only when PARITY_JSONL and PARITY_JSON are set (a real transcript and
// the output of `gerar_log_conversa.py --file <jsonl> --json`).
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildEntry, formatResposta, formatSolicitacao, generateEntryTitle, normalizeSessionName } from "../../src/core/format";
import { parseTranscript } from "../../src/core/transcript";

const jsonl = process.env.PARITY_JSONL;
const json = process.env.PARITY_JSON;

describe.skipIf(!jsonl || !json)("parity with gerar_log_conversa.py", () => {
  it("produces the same entries as the script for a real transcript", () => {
    const expected = JSON.parse(fs.readFileSync(json!, "utf8")) as {
      session: { name?: string };
      turns: Array<{ timestamp: string; title: string; solicitacao: string; resposta: string; files_modified: string[] }>;
    };
    const parsed = parseTranscript(fs.readFileSync(jsonl!, "utf8"), -180);
    const sessionName = normalizeSessionName(expected.session.name ?? "");
    const mine = parsed.turns.map((t) => ({
      timestamp: t.timestamp,
      title: generateEntryTitle(t, sessionName),
      solicitacao: formatSolicitacao(t),
      resposta: formatResposta(t),
    }));
    // The script drops the last turn when its text mentions "log" (it is the request that invoked it);
    // the plugin keeps it because it only writes finished turns and drops explicit log requests.
    const common = Math.min(mine.length, expected.turns.length);
    expect(Math.abs(mine.length - expected.turns.length)).toBeLessThanOrEqual(1);
    const diffs: string[] = [];
    for (let i = 0; i < common; i++) {
      const a = mine[i]!;
      const b = expected.turns[i]!;
      if (a.timestamp !== b.timestamp) diffs.push(`#${i} timestamp ${a.timestamp} != ${b.timestamp}`);
      if (a.title !== b.title) diffs.push(`#${i} title "${a.title}" != "${b.title}"`);
      if (a.solicitacao !== b.solicitacao) diffs.push(`#${i} solicitacao differs`);
      if (a.resposta !== b.resposta) diffs.push(`#${i} resposta differs`);
    }
    console.log(`turns: plugin=${mine.length} script=${expected.turns.length}; diffs=${diffs.length}`);
    expect(diffs).toEqual([]);
    expect(buildEntry(parsed.turns[0]!, sessionName).markdown).toContain("**Solicitação:**");
  });
});
