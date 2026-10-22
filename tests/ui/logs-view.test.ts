import { describe, expect, it } from "vitest";
import { LogsView } from "../../src/ui/logs-view";

describe("LogsView", () => {
  it("opens without throwing and builds the toolbar, columns and list", async () => {
    const handlers: Record<string, unknown[]> = {};
    const on = (name: string) => (evt: string, cb: unknown) => ((handlers[`${name}:${evt}`] ??= []).push(cb), { evt });
    const file = { path: "Knowledge/Logs/21-10-2026 - 12h00 - T.md", basename: "21-10-2026 - 12h00 - T", stat: { ctime: 1, mtime: 2 } };
    const app: any = {
      vault: { getMarkdownFiles: () => [file], on: on("vault"), getFileByPath: () => null },
      metadataCache: {
        getFileCache: () => ({ frontmatter: { tags: ["log", "claude", "sessao/ativo"], sessao: "x" }, headings: [{ level: 2, heading: "Sumário" }, { level: 2, heading: "21/10/2026 - 12:00 - Um" }] }),
        on: on("meta"),
      },
      workspace: {},
    };
    const view: any = new LogsView({ app } as never, { dev: () => ({}) as never, tracker: () => ({}) as never });
    view.registerEvent = () => undefined;
    await view.onOpen();
    expect(view.contentEl.children.length).toBeGreaterThan(1);
    expect(view.records).toHaveLength(1);
  });
});
