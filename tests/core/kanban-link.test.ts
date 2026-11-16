import { describe, expect, it } from "vitest";
import { addLogLink, hasLogLink, kanbanCardsFolder, ticketKeysInRequests } from "../../src/core/kanban-link";
import { assistantLine, makeHarness, userLine } from "../helpers/memory-ports";

const TZ = -180;
const T1 = "2026-10-21T15:00:00.000Z";
const T2 = "2026-10-21T15:01:00.000Z";
const T3 = "2026-10-21T15:05:00.000Z";
const T4 = "2026-10-21T15:06:00.000Z";

const CARD = `---
status: Selecionado p/ Des.
key: KAN-8
title: Link automático
---

## Descrição

Texto do ticket

## Histórico

- 09/11/2026, 18:29:59 - Usuário: criou este ticket
`;

describe("addLogLink", () => {
  it("creates the Logs section at the end and keeps everything else", () => {
    const res = addLogLink(CARD, "21-10-2026 - 12h00 - Meu log");
    expect(res.added).toBe(true);
    expect(res.content.startsWith(CARD.trimEnd())).toBe(true);
    expect(res.content.endsWith("## Logs\n\n- [[21-10-2026 - 12h00 - Meu log]]\n")).toBe(true);
  });

  it("is idempotent", () => {
    const once = addLogLink(CARD, "Log A").content;
    const twice = addLogLink(once, "Log A");
    expect(twice.added).toBe(false);
    expect(twice.content).toBe(once);
  });

  it("adds to an existing Logs section, before the next section, without touching the rest", () => {
    const card = `${CARD}\n## Logs\n\n- [[Log A]]\n\n## Notas\n\nalgo\n`;
    const res = addLogLink(card, "Log B");
    expect(res.content).toBe(`${CARD}\n## Logs\n\n- [[Log A]]\n- [[Log B]]\n\n## Notas\n\nalgo\n`);
  });

  it("recognizes links with folder or alias and does not confuse similar names", () => {
    expect(hasLogLink("- [[Projetos/X/Logs/Log A|alias]]", "Log A")).toBe(true);
    expect(hasLogLink("- [[Log A 2]]", "Log A")).toBe(false);
    expect(hasLogLink("- [[Meu Log A]]", "Log A")).toBe(false);
  });

  it("keeps CRLF line endings", () => {
    const res = addLogLink("## Descrição\r\n\r\ntexto\r\n", "Log A").content;
    expect(res).toBe("## Descrição\r\n\r\ntexto\r\n\r\n## Logs\r\n\r\n- [[Log A]]\r\n");
  });
});

describe("ticketKeysInRequests", () => {
  it("collects keys from the requests only, in order and without repeats", () => {
    expect(ticketKeysInRequests([{ userText: "Faz o KAN-8 e o KAN-10" }, { userText: "de novo KAN-8, e KAN-80x" }])).toEqual(["KAN-8", "KAN-10"]);
    expect(ticketKeysInRequests([{ userText: "sem ticket, utf-8" }])).toEqual([]);
  });
});

describe("LogEngine links logs to Kanban cards (KAN-8)", () => {
  const project = { name: "Proj", folder: "Projetos/Proj", clonePath: undefined };
  const folder = kanbanCardsFolder(project);

  function setup() {
    const h = makeHarness();
    h.vault.projectList = [project];
    h.vault.notes.set(`${folder}/KAN-8 Link automático.md`, CARD);
    h.vault.notes.set(`${folder}/KAN-9 Outro.md`, CARD.replace("KAN-8", "KAN-9"));
    h.vault.notes.set("Projetos/Outro/Outro - Kanban - Cards/KAN-8 Homônimo.md", CARD);
    return h;
  }

  it("links the log in the card of the project when the request cites its key, once", async () => {
    const h = setup();
    h.disk.put(h.transcript, userLine("Implementa o KAN-8", T1) + assistantLine("Feito, mexi também no KAN-9.", T2), 1000);
    const res = await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ, project: "Proj" });
    expect(res.status).toBe("created");
    const logName = res.notaLog!.replace(/^.*\//, "").replace(/\.md$/, "");
    const card = h.vault.notes.get(`${folder}/KAN-8 Link automático.md`)!;
    expect(card.startsWith(CARD.trimEnd())).toBe(true);
    expect(card).toContain(`## Logs\n\n- [[${logName}]]\n`);
    // only the user's request counts, and only the cards of the project
    expect(h.vault.notes.get(`${folder}/KAN-9 Outro.md`)).not.toContain("## Logs");
    expect(h.vault.notes.get("Projetos/Outro/Outro - Kanban - Cards/KAN-8 Homônimo.md")).toBe(CARD);

    // a new turn in the same conversation does not duplicate the link
    h.disk.append(h.transcript, userLine("Continua o KAN-8", T3) + assistantLine("Ok.", T4), 2000);
    expect((await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ })).status).toBe("updated");
    const after = h.vault.notes.get(`${folder}/KAN-8 Link automático.md`)!;
    expect(after.split(`[[${logName}]]`).length - 1).toBe(1);
  });

  it("links a card cited later in the conversation", async () => {
    const h = setup();
    h.disk.put(h.transcript, userLine("Oi", T1) + assistantLine("Olá.", T2), 1000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ, project: "Proj" });
    expect(h.vault.notes.get(`${folder}/KAN-9 Outro.md`)).not.toContain("## Logs");
    h.disk.append(h.transcript, userLine("Agora o KAN-9", T3) + assistantLine("Ok.", T4), 2000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(h.vault.notes.get(`${folder}/KAN-9 Outro.md`)).toContain("## Logs");
  });

  it("falls back to the projects cited when the conversation has no project", async () => {
    const h = setup();
    h.disk.put(h.transcript, userLine("No projeto Proj, implementa o KAN-8", T1) + assistantLine("Feito.", T2), 1000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ });
    expect(h.vault.notes.get(`${folder}/KAN-8 Link automático.md`)).toContain("## Logs");
    expect(h.vault.notes.get("Projetos/Outro/Outro - Kanban - Cards/KAN-8 Homônimo.md")).toBe(CARD);
  });

  it("does nothing when no card matches or in observe mode", async () => {
    const h = setup();
    h.disk.put(h.transcript, userLine("Implementa o KAN-77", T1) + assistantLine("Não existe.", T2), 1000);
    await h.engine.syncTranscript(h.transcript, { tzOffsetMinutes: TZ, project: "Proj" });
    expect(h.vault.notes.get(`${folder}/KAN-8 Link automático.md`)).toBe(CARD);

    const o = setup();
    o.settings.mode = "observe";
    o.disk.put(o.transcript, userLine("Implementa o KAN-8", T1) + assistantLine("Feito.", T2), 1000);
    await o.engine.syncTranscript(o.transcript, { tzOffsetMinutes: TZ, project: "Proj" });
    expect(o.vault.notes.get(`${folder}/KAN-8 Link automático.md`)).toBe(CARD);
  });
});
