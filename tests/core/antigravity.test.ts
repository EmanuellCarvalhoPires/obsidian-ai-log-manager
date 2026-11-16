import { describe, expect, it } from "vitest";
import { parseAntigravitySteps, workspaceFromMetadata, workspaceFromUri } from "../../src/core/antigravity";
import { AntigravitySync } from "../../src/core/antigravity-sync";
import { LogEngine } from "../../src/core/engine";
import { pbAll, pbFields, pbGet, pbString } from "../../src/core/protobuf";
import {
  FakeConversationDb,
  modelStep,
  pbMessage,
  pbText,
  pbVarint,
  userStep,
  varint,
} from "../helpers/antigravity-fixtures";
import type { FakeConversation } from "../helpers/antigravity-fixtures";
import { makeHarness } from "../helpers/memory-ports";

const TZ = -180; // UTC-3
const T1 = "2026-10-21T15:00:00.000Z"; // 12:00 local
const T2 = "2026-10-21T15:01:00.000Z";
const T3 = "2026-10-21T15:05:00.000Z";
const T4 = "2026-10-21T15:06:00.000Z";

const APP = "C:/g/antigravity";
const DB_PATH = `${APP}/conversations/conv-1.db`;
const WORKSPACE = "file:///c%3A/Cofre";

describe("protobuf reader", () => {
  it("reads varints, strings and nested messages by field number", () => {
    const bytes = Uint8Array.from([...pbVarint(1, 300), ...pbText(2, "olá"), ...pbMessage(3, pbText(1, "inner"), pbVarint(2, 7))]);
    expect(pbGet(bytes, 1)).toBe(300);
    expect(pbString(pbGet(bytes, 2))).toBe("olá");
    expect(pbString(pbGet(bytes, 3, 1))).toBe("inner");
    expect(pbGet(bytes, 3, 2)).toBe(7);
    expect(pbGet(bytes, 9)).toBeUndefined();
  });

  it("lists repeated fields in order", () => {
    const bytes = Uint8Array.from([...pbText(5, "a"), ...pbText(5, "b"), ...pbText(5, "c")]);
    expect(pbAll(bytes, 5).map(pbString)).toEqual(["a", "b", "c"]);
  });

  it("handles large varints such as a Unix timestamp", () => {
    expect(varint(1_794_343_560).length).toBe(5);
    expect(pbGet(pbVarint(1, 1_794_343_560), 1)).toBe(1_794_343_560);
  });

  it("returns nothing for bytes that are not a message instead of throwing", () => {
    expect(pbFields(Uint8Array.from([0xff, 0xff, 0xff]))).toEqual([]);
    expect(pbFields(Uint8Array.from([0x12, 0x09, 0x01]))).toEqual([]); // length goes past the end
    expect(pbGet(Uint8Array.from([0x00]), 1)).toBeUndefined(); // field number 0
  });
});

describe("parseAntigravitySteps", () => {
  it("groups user and model steps into turns with text, tools, files and commands", () => {
    const parsed = parseAntigravitySteps(
      [
        userStep("Cria o arquivo de exemplo", T1),
        modelStep("", T1, [{ name: "write_to_file", args: { TargetFile: "C:\\proj\\src\\exemplo.ts" } }]),
        modelStep("", T1, [{ name: "run_command", args: { CommandLine: "npm test\nsegunda linha" } }]),
        modelStep("Arquivo criado.", T2),
        userStep("Obrigado", T3),
        modelStep("De nada.", T4),
      ],
      TZ,
    );
    expect(parsed.turns).toHaveLength(2);
    const [first, second] = parsed.turns;
    expect(first?.timestamp).toBe("21/10/2026 - 12:00");
    expect(first?.userText).toBe("Cria o arquivo de exemplo");
    expect(first?.assistantTexts).toEqual(["Arquivo criado."]);
    expect(first?.tools).toEqual(["write_to_file", "run_command"]);
    expect(first?.filesModified).toEqual(["exemplo.ts"]);
    expect(first?.commands).toEqual(["npm test"]);
    expect(first?.complete).toBe(true);
    expect(second?.userText).toBe("Obrigado");
    expect(parsed.firstTimestamp?.toISOString()).toBe(T1);
  });

  it("never logs the thinking of the model", () => {
    const parsed = parseAntigravitySteps([userStep("Oi", T1), modelStep("Olá!", T2)], TZ);
    expect(JSON.stringify(parsed.turns)).not.toContain("thinking");
  });

  it("marks the last turn as not complete while the model still asks for tools", () => {
    const parsed = parseAntigravitySteps([userStep("Faz algo", T1), modelStep("", T2, [{ name: "run_command", args: { CommandLine: "ls" } }])], TZ);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.complete).toBe(false);
  });

  it("treats messages in a row with no answer as one request", () => {
    const parsed = parseAntigravitySteps([userStep("Primeira parte", T1), userStep("Segunda parte", T2), modelStep("Pronto.", T3)], TZ);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.userText).toBe("Primeira parte\nSegunda parte");
  });

  it("counts attached images and drops the system blocks of the user text", () => {
    const parsed = parseAntigravitySteps([userStep("Veja a tela<system-reminder>interno</system-reminder>", T1, 2), modelStep("Vi.", T2)], TZ);
    expect(parsed.turns[0]?.imagesCount).toBe(2);
    expect(parsed.turns[0]?.userText).toBe("Veja a tela");
  });

  it("reads the edit tools that use Path and the commands of run_command only", () => {
    const parsed = parseAntigravitySteps(
      [
        userStep("Edita", T1),
        modelStep("", T1, [{ name: "edit_file", args: { Path: "/home/x/a.md" } }]),
        modelStep("", T1, [{ name: "view_file", args: { AbsolutePath: "/home/x/b.md" } }]),
        modelStep("Feito.", T2),
      ],
      TZ,
    );
    expect(parsed.turns[0]?.filesModified).toEqual(["a.md"]);
    expect(parsed.turns[0]?.tools).toEqual(["edit_file", "view_file"]);
  });

  it("ignores step types it does not know and steps without a user message", () => {
    const parsed = parseAntigravitySteps([{ stepType: 132, payload: Uint8Array.from([0x08, 0x84, 0x01]) }, modelStep("Sozinho", T1), userStep("Oi", T2), modelStep("Olá", T3)], TZ);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.assistantTexts).toEqual(["Olá"]);
  });
});

describe("workspaces", () => {
  it("turns a file URI into a path", () => {
    expect(workspaceFromUri("file:///c%3A/Users/x/proj")).toBe("c:/Users/x/proj");
    expect(workspaceFromUri("file:///home/x/proj")).toBe("/home/x/proj");
    expect(workspaceFromUri("")).toBeUndefined();
  });

  it("reads the workspace from the metadata blob (field 7)", () => {
    expect(workspaceFromMetadata(pbText(7, WORKSPACE))).toBe("c:/Cofre");
    expect(workspaceFromMetadata(pbText(1, "no workspace"))).toBeUndefined();
    expect(workspaceFromMetadata(undefined)).toBeUndefined();
  });
});

interface Setup extends ReturnType<typeof makeHarness> {
  db: FakeConversationDb;
  sync: AntigravitySync;
  gemini: LogEngine;
  put(steps: FakeConversation["steps"], mtimeMs?: number): void;
}

function setup(now?: () => number): Setup {
  const h = makeHarness();
  const db = new FakeConversationDb();
  const sync = new AntigravitySync({
    db,
    disk: h.disk,
    vault: h.vault,
    tracker: h.tracker,
    store: h.store,
    settings: () => h.settings,
    appFolders: () => [APP],
    now,
  });
  const gemini = new LogEngine({
    antigravity: sync,
    disk: h.disk,
    vault: h.vault,
    locator: h.locator,
    tracker: h.tracker,
    store: h.store,
    settings: () => h.settings,
    now,
  });
  db.summaries.set(`${APP}/conversation_summaries.db`, [{ id: "conv-1", title: "", workspaceUris: [WORKSPACE], lastModifiedMs: undefined, nested: false }]);
  const put = (steps: FakeConversation["steps"], mtimeMs = 1000): void => {
    db.conversations.set(DB_PATH, { steps });
    // The size of the file is what the engine compares: give it one that grows with the steps.
    h.disk.put(DB_PATH, "x".repeat(steps.length * 10), mtimeMs);
  };
  return { ...h, db, sync, gemini, put };
}

const firstTurn = [userStep("Quero ver os logs do Gemini", T1), modelStep("Vou ler o banco.", T2)];
const secondTurn = [userStep("Agora o watcher", T3), modelStep("Feito.", T4)];

describe("AntigravitySync", () => {
  it("creates the log of a Gemini conversation from the .db with the gemini tag and the source properties", async () => {
    const s = setup();
    s.put(firstTurn);
    const res = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("created");
    expect(res.added).toBe(1);
    expect(res.notaLog).toBe("Knowledge/Logs/21-10-2026 - 12h00 - Quero ver os logs do Gemini.md");
    const note = s.vault.notes.get(res.notaLog!)!;
    expect(note).toContain("  - log\n  - gemini\n  - sessao/ativo");
    expect(note).toContain("sessao: conv-1");
    expect(note).toContain('jsonl: "conv-1.db"');
    expect(note).toContain(`jsonl_caminho: "${DB_PATH}"`);
    expect(note).toContain("**Solicitação:** Quero ver os logs do Gemini");
    expect(note).toContain("**Resposta:** Vou ler o banco.");
    expect(s.store.get("conv-1")?.caminhoTranscript).toBe(DB_PATH);
  });

  it("appends only the new entry, is idempotent and never rewrites what is there", async () => {
    const s = setup();
    s.put(firstTurn, 1000);
    const created = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    const before = s.vault.notes.get(created.notaLog!)!;
    expect((await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ })).status).toBe("unchanged");
    expect(s.db.reads).toBe(1); // nothing changed: the database is not read again

    s.put([...firstTurn, ...secondTurn], 2000);
    const res = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("updated");
    expect(res.added).toBe(1);
    const after = s.vault.notes.get(created.notaLog!)!;
    expect(after).toContain(before.slice(before.indexOf("## 21/10/2026 - 12:00")));
    expect(after).toContain("## 21/10/2026 - 12:05 - Agora o watcher");

    const forced = await s.sync.syncFile(DB_PATH, { force: true, tzOffsetMinutes: TZ });
    expect(forced.added).toBe(0);
    expect(s.vault.notes.size).toBe(1);
  });

  it("notices a new step that only reached the -wal file", async () => {
    const s = setup();
    s.put(firstTurn, 1000);
    await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    // The .db file is untouched; the new steps are in the write-ahead log.
    s.db.conversations.set(DB_PATH, { steps: [...firstTurn, ...secondTurn] });
    s.disk.put(`${DB_PATH}-wal`, "w".repeat(64), 3000);
    const res = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("updated");
    expect(res.added).toBe(1);
  });

  it("does not write a turn the model has not finished, until it is flushed", async () => {
    const s = setup();
    s.put([userStep("Faz algo longo", T1), modelStep("", T2, [{ name: "run_command", args: { CommandLine: "npm test" } }])]);
    expect((await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ })).status).toBe("pending");
    expect(s.vault.notes.size).toBe(0);
    expect(s.store.get("conv-1")?.temTurnoPendente).toBe(true);
    expect((await s.sync.syncFile(DB_PATH, { flush: true, tzOffsetMinutes: TZ })).status).toBe("created");
  });

  it("ignores conversations of subagents and conversations outside the tracked folders", async () => {
    const s = setup();
    s.put(firstTurn);
    s.db.summaries.set(`${APP}/conversation_summaries.db`, [{ id: "conv-1", title: "", workspaceUris: [WORKSPACE], lastModifiedMs: undefined, nested: true }]);
    expect((await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ })).status).toBe("ignored");

    const other = setup();
    other.put(firstTurn);
    other.db.summaries.set(`${APP}/conversation_summaries.db`, [
      { id: "conv-1", title: "", workspaceUris: ["file:///d%3A/Outro"], lastModifiedMs: undefined, nested: false },
    ]);
    expect((await other.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ })).status).toBe("ignored");
    expect(other.store.get("conv-1")?.ignorada).toBe(true);
    expect(other.vault.notes.size).toBe(0);
  });

  it("falls back to the workspace in the database when the index has none", async () => {
    const s = setup();
    s.put(firstTurn);
    s.db.summaries.set(`${APP}/conversation_summaries.db`, []);
    s.db.conversations.set(DB_PATH, { steps: firstTurn, workspaceUri: WORKSPACE });
    expect((await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ })).status).toBe("created");
  });

  it("names the log with the title of the conversation in the index", async () => {
    const s = setup();
    s.put(firstTurn);
    s.db.summaries.set(`${APP}/conversation_summaries.db`, [
      { id: "conv-1", title: "Leitura do banco do Gemini", workspaceUris: [WORKSPACE], lastModifiedMs: undefined, nested: false },
    ]);
    const res = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(res.notaLog).toBe("Knowledge/Logs/21-10-2026 - 12h00 - Leitura do banco do Gemini.md");
  });

  it("uses the title and project chosen with logs_set when the log is created", async () => {
    const s = setup();
    s.put(firstTurn);
    s.vault.projectList = [{ name: "Meu Projeto", folder: "Projetos/Meu Projeto", clonePath: "C:/Cofre" }];
    const res = await s.sync.syncFile(DB_PATH, { title: "Título escolhido", tzOffsetMinutes: TZ });
    expect(res.notaLog).toBe("Projetos/Meu Projeto/Logs/21-10-2026 - 12h00 - Título escolhido.md");
    const note = s.vault.notes.get(res.notaLog!)!;
    expect(note).toContain('projeto: "[[Meu Projeto]]"');
    expect(note).toContain('  - "[[Memória Claude]]"');
  });

  it("finds a log that already exists (made by the old script) instead of creating another one", async () => {
    const s = setup();
    s.put(firstTurn);
    const created = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    s.store.delete("conv-1"); // like a plugin that never saw this conversation
    const res = await s.sync.syncFile(DB_PATH, { force: true, tzOffsetMinutes: TZ });
    expect(res.notaLog).toBe(created.notaLog);
    expect(res.added).toBe(0);
    expect(s.vault.notes.size).toBe(1);
  });

  it("does not recreate a log the user deleted", async () => {
    const s = setup();
    s.put(firstTurn, 1000);
    const created = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    s.vault.notes.delete(created.notaLog!);
    s.put([...firstTurn, ...secondTurn], 2000);
    const res = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("ignored");
    expect(s.vault.notes.size).toBe(0);
  });

  it("only observes in observe mode", async () => {
    const s = setup();
    s.put(firstTurn);
    s.settings.mode = "observe";
    const res = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("observed");
    expect(s.vault.notes.size).toBe(0);
  });

  it("reports an error, without writing, when the database cannot be read (no SQLite)", async () => {
    const s = setup();
    s.disk.put(DB_PATH, "x"); // the file exists but the fake has no content for it
    const res = await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(res.status).toBe("error");
    expect(s.vault.notes.size).toBe(0);
  });

  it("reports a missing database", async () => {
    const s = setup();
    expect((await s.sync.syncFile(`${APP}/conversations/none.db`)).status).toBe("missing");
    expect(await s.sync.syncSession("none")).toBeUndefined();
  });

  it("lists the top-level conversations of every app, newest first, and skips the subagents", async () => {
    const s = setup();
    s.put(firstTurn, 1000);
    s.disk.put(`${APP}/conversations/conv-2.db`, "x", 5000);
    s.disk.put(`${APP}/conversations/conv-sub.db`, "x", 9000);
    s.disk.put(`${APP}/conversations/readme.txt`, "x", 9999);
    s.db.summaries.set(`${APP}/conversation_summaries.db`, [
      { id: "conv-1", title: "", workspaceUris: [WORKSPACE], lastModifiedMs: undefined, nested: false },
      { id: "conv-sub", title: "", workspaceUris: [WORKSPACE], lastModifiedMs: undefined, nested: true },
    ]);
    expect((await s.sync.list()).map((r) => r.id)).toEqual(["conv-2", "conv-1"]);
  });

  it("reads the index once per few seconds, not once per file event", async () => {
    let clock = 10_000;
    const s = setup(() => clock);
    s.put(firstTurn, 1000);
    await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    s.put([...firstTurn, ...secondTurn], 2000);
    await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(s.db.summaryReads).toBe(1);
    clock += 60_000;
    s.put([...firstTurn, ...secondTurn, userStep("Mais um", "2026-10-21T16:00:00.000Z"), modelStep("Ok.", "2026-10-21T16:01:00.000Z")], 3000);
    await s.sync.syncFile(DB_PATH, { tzOffsetMinutes: TZ });
    expect(s.db.summaryReads).toBe(2);
  });
});

describe("LogEngine with Gemini conversations", () => {
  it("reconciles .db conversations in syncAll and does not prune their checkpoints", async () => {
    const s = setup();
    s.put(firstTurn);
    const first = await s.gemini.syncAll({ force: true, tzOffsetMinutes: TZ });
    expect(first.filter((r) => r.status === "created")).toHaveLength(1);
    expect(s.store.get("conv-1")?.notaLog).toBeDefined();
    const second = await s.gemini.syncAll({ tzOffsetMinutes: TZ });
    expect(second).toHaveLength(0); // unchanged: skipped
    expect(s.store.get("conv-1")?.notaLog).toBeDefined(); // not pruned for being absent from the JSONL list
  });

  it("only reconciles conversations changed after the last reconciliation, unless it is forced", async () => {
    const s = setup();
    s.put(firstTurn, 1000); // older than the checkpoint file's last reconciliation (5000 in the harness)
    expect(await s.gemini.syncAll({ tzOffsetMinutes: TZ })).toHaveLength(0);
    s.put(firstTurn, 9000);
    expect((await s.gemini.syncAll({ tzOffsetMinutes: TZ })).map((r) => r.status)).toEqual(["created"]);
  });

  it("routes syncSession of a Gemini conversation to the .db and keeps Claude sessions missing when unknown", async () => {
    const s = setup();
    s.put(firstTurn, 1000);
    expect((await s.gemini.syncSession("conv-1", { tzOffsetMinutes: TZ })).status).toBe("created");
    s.put([...firstTurn, ...secondTurn], 2000);
    // now the checkpoint knows the .db path
    const again = await s.gemini.syncSession("conv-1", { tzOffsetMinutes: TZ });
    expect(again.status).toBe("updated");
    expect((await s.gemini.syncSession("nope")).status).toBe("missing");
  });

  it("marks a Gemini checkpoint as deleted when the user deletes the log note", async () => {
    const s = setup();
    s.put(firstTurn);
    const created = await s.gemini.syncSession("conv-1", { tzOffsetMinutes: TZ });
    s.gemini.onNoteDeleted(created.notaLog!);
    expect(s.store.get("conv-1")?.apagadaPeloUsuario).toBe(true);
  });
});
