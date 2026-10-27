import { describe, expect, it } from "vitest";
import type { HookHandler } from "../../src/core/hook-handler";
import { SessionLocator } from "../../src/core/session-locator";
import type { HubCallContext, HubTool } from "../../src/ecosystem/types";
import { ACTIVE_WINDOW_MS, buildTools, resolveSession } from "../../src/tools/log-module";
import { assistantLine, makeHarness, toolUseLine, userLine } from "../helpers/memory-ports";

const TZ = -180;
const T1 = "2026-10-21T15:00:00.000Z";
const T2 = "2026-10-21T15:01:00.000Z";
const T3 = "2026-10-21T15:05:00.000Z";
const CTX: HubCallContext = { client: { id: "test", name: "test" }, moduleId: "ai-log-manager" };

function setup() {
  const h = makeHarness();
  const locator = new SessionLocator(h.disk, () => h.settings.claudeHome, () => 0);
  const tools = buildTools({
    engine: h.engine,
    locator,
    tracker: h.tracker,
    store: h.store,
    hooks: {} as HookHandler,
    settings: () => h.settings,
    runtime: () => ({ watching: true, hooksInstalled: true, connected: true }),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name) as HubTool;
    const res = await tool.handler(args, CTX);
    return { data: JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>, isError: res.isError === true };
  };
  return { h, locator, tools, call };
}

describe("log-module tools", () => {
  it("offers logs_set and no longer offers logs_create", () => {
    const { tools } = setup();
    const names = tools.map((t) => t.name);
    expect(names).toContain("logs_set");
    expect(names).not.toContain("logs_create");
  });

  it("logs_set without arguments fails with a clear message", async () => {
    const { call } = setup();
    const res = await call("logs_set", { sessao: "sess-1" });
    expect(res.isError).toBe(true);
    expect(String(res.data.error)).toContain("at least one");
  });

  it("logs_set before the log exists keeps the title for the creation", async () => {
    const { h, call } = setup();
    h.disk.put(h.transcript, userLine("Faz algo longo", T1) + toolUseLine("Bash", { command: "npm test" }, T2), 1000);
    const res = await call("logs_set", { sessao: "sess-1", titulo: "Título escolhido" });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe("pending");
    h.disk.append(h.transcript, assistantLine("Terminei.", T3), 2000);
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(created.notaLog).toBe("Knowledge/Logs/21-10-2026 - 12h00 - Título escolhido.md");
  });

  it("logs_set after the log exists renames it", async () => {
    const { h, call } = setup();
    h.disk.put(h.transcript, userLine("Quero criar o plugin", T1) + assistantLine("Ok.", T2), 1000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    const res = await call("logs_set", { sessao: "sess-1", titulo: "Novo título" });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe("renamed");
    expect(res.data.note).toBe("Knowledge/Logs/21-10-2026 - 12h00 - Novo título.md");
    expect(h.vault.notes.has("Knowledge/Logs/21-10-2026 - 12h00 - Novo título.md")).toBe(true);
  });

  it("logs_set links project and branches before the log exists", async () => {
    const { h, call } = setup();
    h.vault.projectList = [{ name: "Meu App", folder: "Projetos/Meu App", clonePath: undefined }];
    h.disk.put(h.transcript, userLine("Faz algo longo", T1) + toolUseLine("Bash", { command: "npm test" }, T2), 1000);
    const res = await call("logs_set", { sessao: "sess-1", titulo: "Corrige o bug", projeto: "Meu App", branches: ["Meu App - feature-x"] });
    expect(res.isError).toBe(false);
    h.disk.append(h.transcript, assistantLine("Terminei.", T3), 2000);
    const created = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(created.notaLog).toBe("Projetos/Meu App/Logs/21-10-2026 - 12h00 - Corrige o bug.md");
    const note = h.vault.notes.get(created.notaLog!)!;
    expect(note).toContain('  - "[[Meu App - feature-x]]"');
  });
});

describe("resolveSession", () => {
  const NOW = 10_000_000;
  const dir = "C:/home/.claude/projects/proj";

  function make() {
    const { h, locator } = setup();
    const resolve = (explicit?: unknown) => resolveSession({ locator, store: h.store }, explicit, () => NOW);
    return { h, resolve };
  }

  it("an explicit id always wins", async () => {
    const { h, resolve } = make();
    h.disk.put(`${dir}/a.jsonl`, "", NOW - 1000);
    h.disk.put(`${dir}/b.jsonl`, "", NOW - 2000);
    expect(await resolve("zzz")).toEqual({ session: "zzz" });
  });

  it("returns the only active conversation", async () => {
    const { h, resolve } = make();
    h.disk.put(`${dir}/a.jsonl`, "", NOW - 1000);
    h.disk.put(`${dir}/b.jsonl`, "", NOW - ACTIVE_WINDOW_MS - 1000);
    expect(await resolve()).toEqual({ session: "a" });
  });

  it("fails and lists the ids when more than one conversation is active", async () => {
    const { h, resolve } = make();
    h.disk.put(`${dir}/a.jsonl`, "", NOW - 1000);
    h.disk.put(`${dir}/b.jsonl`, "", NOW - 2000);
    const res = await resolve();
    expect("error" in res).toBe(true);
    const message = "error" in res ? res.error : "";
    expect(message).toContain("a (");
    expect(message).toContain("b (");
    expect(message).toContain("sessao");
  });

  it("falls back to the newest tracked conversation when none is active", async () => {
    const { h, resolve } = make();
    h.disk.put(`${dir}/old.jsonl`, "", NOW - ACTIVE_WINDOW_MS - 9000);
    h.disk.put(`${dir}/newer.jsonl`, "", NOW - ACTIVE_WINDOW_MS - 1000);
    expect(await resolve()).toEqual({ session: "newer" });
  });

  it("ignores conversations marked as ignored", async () => {
    const { h, resolve } = make();
    h.disk.put(`${dir}/a.jsonl`, "", NOW - 1000);
    h.disk.put(`${dir}/b.jsonl`, "", NOW - 2000);
    h.store.set({ sessao: "b", hostSessionId: "", caminhoTranscript: "", offset: 0, mtimeMs: 0, hashUltimoRegistro: "", notaLog: undefined, projeto: undefined, ignorada: true });
    expect(await resolve()).toEqual({ session: "a" });
  });

  it("fails when there is no transcript at all", async () => {
    const { resolve } = make();
    expect(await resolve()).toEqual({ error: "No conversation found." });
  });
});

describe("logs_status", () => {
  const checkpoint = (n: number) => ({
    sessao: `s${n}`,
    hostSessionId: "",
    caminhoTranscript: `C:/t/s${n}.jsonl`,
    offset: 1,
    mtimeMs: n,
    hashUltimoRegistro: `entry ${n}`,
    notaLog: `Knowledge/Logs/n${n}.md`,
    projeto: "App",
  });

  it("lists 3 conversations by default, with only session, note and project", async () => {
    const { h, call } = setup();
    for (let n = 1; n <= 5; n++) h.store.set(checkpoint(n));
    const res = await call("logs_status", {});
    const sessions = res.data.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.session)).toEqual(["s5", "s4", "s3"]);
    expect(Object.keys(sessions[0]!).sort()).toEqual(["note", "project", "session"]);
  });

  it("still accepts an explicit limit", async () => {
    const { h, call } = setup();
    for (let n = 1; n <= 5; n++) h.store.set(checkpoint(n));
    const res = await call("logs_status", { limit: 5 });
    expect((res.data.sessions as unknown[]).length).toBe(5);
  });
});

