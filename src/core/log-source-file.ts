// Finds the file an AI conversation log was made from: the Claude Code transcript (.jsonl) or the
// Antigravity conversation database (.db). Pure: the disk and the checkpoints come through `deps`.
import type { LogRecord } from "./log-index";

export interface SourceFile {
  /** "jsonl" can be read and shown; "db" (Antigravity) can only be revealed on disk. */
  kind: "jsonl" | "db";
  /** Absolute path. */
  path: string;
}

export interface SourceFileDeps {
  exists(path: string): Promise<boolean>;
  /** Transcript the checkpoints recorded for the `sessao` of a log. */
  fromCheckpoint(sessao: string): string | undefined;
  /** Searches the Claude Code projects folder for `<session>.jsonl`. */
  findTranscript(sessionId: string): Promise<string | undefined>;
  /** Folders (absolute) that hold the Antigravity conversations (`<id>.db`). */
  conversationFolders(): string[];
}

const kindOf = (path: string): SourceFile["kind"] => (path.toLowerCase().endsWith(".db") ? "db" : "jsonl");

export async function resolveSourceFile(record: Pick<LogRecord, "agent" | "sessao" | "transcript">, deps: SourceFileDeps): Promise<SourceFile | undefined> {
  if (record.transcript && (await deps.exists(record.transcript))) return { kind: kindOf(record.transcript), path: record.transcript };
  const sessao = record.sessao;
  if (!sessao) return undefined;

  if (record.agent === "gemini") {
    for (const folder of deps.conversationFolders()) {
      const candidate = `${folder.replace(/\\/g, "/").replace(/\/+$/, "")}/${sessao}.db`;
      if (await deps.exists(candidate)) return { kind: "db", path: candidate };
    }
    return undefined;
  }

  const recorded = deps.fromCheckpoint(sessao);
  if (recorded && (await deps.exists(recorded))) return { kind: "jsonl", path: recorded };
  const found = await deps.findTranscript(sessao.replace(/^local_/, ""));
  return found ? { kind: "jsonl", path: found } : undefined;
}
