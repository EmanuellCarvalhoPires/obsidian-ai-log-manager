// ConversationDbPort on top of Node's built-in `node:sqlite` (desktop only). Chosen over a WASM build such as sql.js
// because it adds nothing to main.js and it reads the file where it is (read-only), without loading it all into memory
// or copying it. Obsidian 1.13+ runs on an Electron whose Node has it; the module is loaded on first use, so an
// Obsidian without it only loses the Gemini logs (the calls reject and the engine reports an error for them).
import type { DatabaseSync } from "node:sqlite";
import type { ConversationDbPort, ConversationDbStep, ConversationSummary } from "../core/ports";
import * as fs from "node:fs/promises";

type Row = Record<string, unknown>;

/**
 * Antigravity keeps its databases in WAL mode. Opening one normally, even read-only, makes SQLite create the `-wal` and
 * `-shm` files next to it, so every conversation read would leave two empty files in the user's `.gemini` folder. When
 * there is no pending write-ahead log (the file is missing or empty) the database is opened `immutable`, which reads
 * the file as it is and touches nothing. With pending data the normal read-only mode is needed to see it.
 */
async function openReadOnly(path: string): Promise<DatabaseSync> {
  const sqlite = await import("node:sqlite");
  let idle = false;
  try {
    idle = (await fs.stat(`${path}-wal`)).size === 0;
  } catch {
    idle = true; // no -wal file at all
  }
  if (idle) {
    const url = await import("node:url");
    return new sqlite.DatabaseSync(`${url.pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
  }
  return new sqlite.DatabaseSync(path, { readOnly: true });
}

/** Runs `job` with a read-only connection and always closes it. */
async function withDb<T>(path: string, job: (db: DatabaseSync) => T): Promise<T> {
  const db = await openReadOnly(path);
  try {
    return job(db);
  } finally {
    db.close();
  }
}

const asBytes = (v: unknown): Uint8Array | undefined => (v instanceof Uint8Array ? v : undefined);
const asText = (v: unknown): string => (typeof v === "string" ? v : "");

/** "2026-11-10 20:56:22.5738541+00:00" is not ISO 8601 for the JavaScript parser: milliseconds and a "T" are needed. */
export function parseSummaryTime(text: string): number | undefined {
  const iso = text.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseUris(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json || "[]");
    return Array.isArray(value) ? value.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export function createNodeSqlite(): ConversationDbPort {
  return {
    async readSteps(dbPath: string, stepTypes: number[]): Promise<ConversationDbStep[]> {
      if (stepTypes.length === 0) return [];
      const marks = stepTypes.map(() => "?").join(", ");
      return withDb(dbPath, (db) => {
        const rows = db.prepare(`SELECT step_type, step_payload FROM steps WHERE step_type IN (${marks}) ORDER BY idx`).all(...stepTypes) as Row[];
        const steps: ConversationDbStep[] = [];
        for (const row of rows) {
          const payload = asBytes(row.step_payload);
          if (payload && typeof row.step_type === "number") steps.push({ stepType: row.step_type, payload });
        }
        return steps;
      });
    },

    async readMetadata(dbPath: string): Promise<Uint8Array | undefined> {
      return withDb(dbPath, (db) => {
        const row = db.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 1").get() as Row | undefined;
        return asBytes(row?.data);
      });
    },

    async readSummaries(summariesPath: string): Promise<ConversationSummary[]> {
      try {
        await fs.access(summariesPath);
      } catch {
        return [];
      }
      return withDb(summariesPath, (db) => {
        const rows = db.prepare("SELECT * FROM conversation_summaries").all() as Row[];
        return rows
          .filter((r) => asText(r.conversation_id) !== "")
          .map((r) => ({
            id: asText(r.conversation_id),
            title: asText(r.title),
            workspaceUris: parseUris(asText(r.workspace_uris)),
            lastModifiedMs: parseSummaryTime(asText(r.last_modified_time)),
            nested: (typeof r.nesting_depth === "number" && r.nesting_depth > 0) || asText(r.parent_conversation_id) !== "",
          }));
      });
    },
  };
}
