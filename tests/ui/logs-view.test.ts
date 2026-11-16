import { describe, expect, it } from "vitest";
import { LogsView } from "../../src/ui/logs-view";

interface Fake {
  path: string;
  basename: string;
  agent: string;
  stat: { ctime: number; mtime: number };
}

function file(n: number, agent: string): Fake {
  const word = ["Gama", "Alfa", "Beta"][n] ?? "Delta";
  const name = `21-10-2026 - 1${n}h00 - Conversa ${word}`;
  return { path: `Knowledge/Logs/${name}.md`, basename: name, agent, stat: { ctime: 1, mtime: 2 } };
}

async function openView(files: Fake[]): Promise<any> {
  const handlers: Record<string, unknown[]> = {};
  const on = (name: string) => (evt: string, cb: unknown) => ((handlers[`${name}:${evt}`] ??= []).push(cb), { evt });
  const app: any = {
    vault: { getMarkdownFiles: () => files, on: on("vault"), getFileByPath: () => null },
    metadataCache: {
      getFileCache: (f: Fake) => ({
        frontmatter: { tags: ["log", f.agent, "sessao/ativo"], sessao: f.basename },
        headings: [{ level: 2, heading: "Sumário" }, { level: 2, heading: "21/10/2026 - 12:00 - Um" }],
      }),
      on: on("meta"),
    },
    workspace: {},
    loadLocalStorage: () => null,
    saveLocalStorage: () => undefined,
  };
  const view: any = new LogsView({ app } as never);
  view.registerEvent = () => undefined;
  await view.onOpen();
  return view;
}

describe("LogsView", () => {
  it("opens without throwing and builds the toolbar, columns and list", async () => {
    const view = await openView([file(0, "claude")]);
    expect(view.contentEl.children.length).toBeGreaterThan(1);
    expect(view.records).toHaveLength(1);
  });

  it("lights the chosen row in place, without drawing the list again", async () => {
    const view = await openView([file(1, "claude"), file(2, "claude")]);
    const [first, second] = view.records.map((r: { path: string }) => r.path) as string[];
    const rowA = view.rowEls.get(first);
    const rowB = view.rowEls.get(second);
    view.select(first as string);
    expect(rowA.hasClass("is-active")).toBe(true);
    view.select(second as string);
    expect(rowA.hasClass("is-active")).toBe(false);
    expect(rowB.hasClass("is-active")).toBe(true);
    // Same elements as before: the list was not rebuilt, so its scroll position could not jump.
    expect(view.rowEls.get(first)).toBe(rowA);
    expect(view.rowEls.get(second)).toBe(rowB);
  });

  it("fills the header of the log as soon as it is chosen", async () => {
    const view = await openView([file(1, "claude")]);
    expect(view.headEl.hasClass("is-empty")).toBe(true);
    view.select(view.records[0].path as string);
    expect(view.headEl.hasClass("is-empty")).toBe(false);
  });

  it("filters the list by the search box and shows the clear button only while it has text", async () => {
    const view = await openView([file(1, "claude"), file(2, "claude")]);
    expect(view.visible).toHaveLength(2);
    expect(view.clearEl.hasClass("is-hidden")).toBe(true);
    view.applyQuery("beta", true);
    expect(view.visible).toHaveLength(1);
    expect(view.clearEl.hasClass("is-hidden")).toBe(false);
    view.applyQuery("", true);
    expect(view.visible).toHaveLength(2);
    expect(view.clearEl.hasClass("is-hidden")).toBe(true);
  });

  it("offers the agent filter only when there is more than one agent", async () => {
    const one = await openView([file(1, "claude")]);
    expect(one.agentsEl.hasClass("is-hidden")).toBe(true);
    const two = await openView([file(1, "claude"), file(2, "gemini")]);
    expect(two.agentsEl.hasClass("is-hidden")).toBe(false);
    // "All" plus one button per agent.
    expect(two.agentButtons.size).toBe(3);
    two.filters.agent = "gemini";
    two.renderList();
    expect(two.visible).toHaveLength(1);
  });

  it("does not make filter buttons out of tags that are not agents", async () => {
    const view = await openView([file(1, "claude"), file(2, "gemini"), file(0, "dev/projeto"), file(3, "moc")]);
    // "All", Claude and Antigravity only; the other notes still show in the list.
    expect(view.agentButtons.size).toBe(3);
    expect([...view.agentButtons.keys()].sort()).toEqual(["", "claude", "gemini"]);
    expect(view.visible).toHaveLength(4);
  });

  it("folds the turns column away in the JSONL tab and brings it back in the Markdown tab", async () => {
    const view = await openView([file(1, "claude")]);
    expect(view.columnsEl.style["--ailm-rail-w"]).toBe("200px");
    view.layout.mode = "jsonl";
    view.updateTabs();
    expect(view.columnsEl.style["--ailm-rail-w"]).toBe("0px");
    view.layout.mode = "md";
    view.updateTabs();
    expect(view.columnsEl.style["--ailm-rail-w"]).toBe("200px");
  });
});
