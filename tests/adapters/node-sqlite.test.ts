import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeSqlite, parseSummaryTime } from "../../src/adapters/node-sqlite";
import { parseAntigravitySteps } from "../../src/core/antigravity";
import { modelStep, pbText, userStep } from "../helpers/antigravity-fixtures";

// The adapter needs the built-in `node:sqlite` (Node 22.5+, which Obsidian 1.13+ ships); skip where it is not there.
let sqlite: typeof import("node:sqlite") | undefined;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = undefined;
}

describe("parseSummaryTime", () => {
  it("reads the timestamp format of conversation_summaries.db", () => {
    expect(parseSummaryTime("2026-11-10 20:56:22.5738541+00:00")).toBe(Date.parse("2026-11-10T20:56:22.573Z"));
    expect(parseSummaryTime("")).toBeUndefined();
    expect(parseSummaryTime("not a date")).toBeUndefined();
  });
});

describe.skipIf(!sqlite)("createNodeSqlite (real SQLite files, synthetic data)", () => {
  let dir = "";
  let dbPath = "";
  let summariesPath = "";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-sqlite-"));
    dbPath = path.join(dir, "conv-1.db");
    summariesPath = path.join(dir, "conversation_summaries.db");
    const { DatabaseSync } = sqlite!;

    const conv = new DatabaseSync(dbPath);
    conv.exec("CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx))");
    conv.exec("CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id))");
    const insert = conv.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)");
    const steps = [
      { idx: 0, ...userStep("Pergunta de teste", "2026-10-21T15:00:00.000Z") },
      { idx: 1, stepType: 132, payload: Uint8Array.from([0x08, 0x84, 0x01]) }, // tool result: not read
      { idx: 2, ...modelStep("Resposta de teste.", "2026-10-21T15:01:00.000Z") },
    ];
    for (const s of steps) insert.run(s.idx, s.stepType, s.payload);
    conv.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(pbText(7, "file:///c%3A/Cofre"));
    conv.close();

    const summaries = new DatabaseSync(summariesPath);
    summaries.exec(
      "CREATE TABLE conversation_summaries (conversation_id text, title text, workspace_uris text, last_modified_time text, nesting_depth integer, parent_conversation_id text)",
    );
    const add = summaries.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)");
    add.run("conv-1", "Titulo", JSON.stringify(["file:///c%3A/Cofre"]), "2026-11-10 20:56:22.5738541+00:00", 0, "");
    add.run("conv-sub", "Sub", "[]", "2026-11-10 20:57:00.0000000+00:00", 1, "conv-1");
    add.run("conv-child", "Filho", "not json", "", 0, "conv-1");
    summaries.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads only the requested step types, in order, ready for the parser", async () => {
    const steps = await createNodeSqlite().readSteps(dbPath, [14, 15]);
    expect(steps.map((s) => s.stepType)).toEqual([14, 15]);
    const parsed = parseAntigravitySteps(steps, -180);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.userText).toBe("Pergunta de teste");
    expect(parsed.turns[0]?.assistantTexts).toEqual(["Resposta de teste."]);
  });

  it("reads the metadata blob", async () => {
    const blob = await createNodeSqlite().readMetadata(dbPath);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(blob)).toContain("file:///c%3A/Cofre");
  });

  it("reads the summaries: title, workspaces, time and which conversations are nested", async () => {
    const rows = await createNodeSqlite().readSummaries(summariesPath);
    expect(rows).toEqual([
      { id: "conv-1", title: "Titulo", workspaceUris: ["file:///c%3A/Cofre"], lastModifiedMs: Date.parse("2026-11-10T20:56:22.573Z"), nested: false },
      { id: "conv-sub", title: "Sub", workspaceUris: [], lastModifiedMs: Date.parse("2026-11-10T20:57:00.000Z"), nested: true },
      { id: "conv-child", title: "Filho", workspaceUris: [], lastModifiedMs: undefined, nested: true },
    ]);
  });

  it("returns no summaries when the index file does not exist", async () => {
    expect(await createNodeSqlite().readSummaries(path.join(dir, "missing.db"))).toEqual([]);
  });

  it("opens the file read-only: it does not change the database", async () => {
    const before = fs.readFileSync(dbPath);
    const stat = fs.statSync(dbPath);
    const port = createNodeSqlite();
    await port.readSteps(dbPath, [14, 15]);
    await port.readMetadata(dbPath);
    const after = fs.readFileSync(dbPath);
    expect(after.equals(before)).toBe(true);
    expect(fs.statSync(dbPath).mtimeMs).toBe(stat.mtimeMs);
  });

  it("leaves no -wal or -shm files behind when it reads a database in WAL mode", async () => {
    const walDb = path.join(dir, "wal-idle.db");
    const writer = new sqlite!.DatabaseSync(walDb);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("CREATE TABLE steps (idx integer, step_type integer, step_payload blob)");
    writer.prepare("INSERT INTO steps VALUES (0, 14, ?)").run(userStep("Em WAL", "2026-10-21T15:00:00.000Z").payload);
    writer.close(); // a clean close checkpoints and removes the sidecar files
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("wal-idle.db-"))).toEqual([]);

    const steps = await createNodeSqlite().readSteps(walDb, [14]);
    expect(steps).toHaveLength(1);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("wal-idle.db-"))).toEqual([]);
  });

  it("sees the steps that are still only in the -wal file of a database another process holds open", async () => {
    const walDb = path.join(dir, "wal-active.db");
    const writer = new sqlite!.DatabaseSync(walDb);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE steps (idx integer, step_type integer, step_payload blob)");
    writer.prepare("INSERT INTO steps VALUES (0, 14, ?)").run(userStep("Primeira", "2026-10-21T15:00:00.000Z").payload);
    try {
      expect(fs.statSync(`${walDb}-wal`).size).toBeGreaterThan(0);
      expect(await createNodeSqlite().readSteps(walDb, [14])).toHaveLength(1);
      writer.prepare("INSERT INTO steps VALUES (1, 14, ?)").run(userStep("Segunda", "2026-10-21T15:01:00.000Z").payload);
      expect(await createNodeSqlite().readSteps(walDb, [14])).toHaveLength(2);
    } finally {
      writer.close();
    }
  });

  it("rejects when the file is not a readable database", async () => {
    const bad = path.join(dir, "bad.db");
    fs.writeFileSync(bad, "this is not sqlite");
    await expect(createNodeSqlite().readSteps(bad, [14])).rejects.toThrow();
    await expect(createNodeSqlite().readSteps(path.join(dir, "absent.db"), [14])).rejects.toThrow();
  });
});
