import { describe, expect, it } from "vitest";
import { LogsView } from "../../src/ui/logs-view";

interface Fake {
  path: string;
  basename: string;
  frontmatter: Record<string, unknown>;
  stat: { ctime: number; mtime: number };
}

const fake = (name: string, extraTags: string[], frontmatter: Record<string, unknown>): Fake => ({
  path: `Knowledge/Logs/${name}.md`,
  basename: name,
  frontmatter: { tags: ["log", "claude", ...extraTags, "sessao/ativo"], ...frontmatter },
  stat: { ctime: 1, mtime: 2 },
});

async function openView(files: Fake[]): Promise<any> {
  const on = () => (_evt: string, _cb: unknown) => ({});
  const app: any = {
    vault: { getMarkdownFiles: () => files, on: on(), getFileByPath: () => null },
    metadataCache: {
      getFileCache: (f: Fake) => ({
        frontmatter: f.frontmatter,
        headings: [{ level: 2, heading: "Sumário" }, { level: 2, heading: "21/10/2026 - 12:00 - Um" }],
      }),
      on: on(),
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

/** Elements of the mock DOM under `root` that have the class. */
function byClass(root: any, cls: string): any[] {
  const found: any[] = root.hasClass?.(cls) ? [root] : [];
  for (const child of root.children ?? []) found.push(...byClass(child, cls));
  return found;
}

const click = (el: any): void => el.dispatchEvent({ type: "click", stopPropagation() {} });

const logs = (): Fake[] => [
  fake("21-10-2026 - 10h00 - Conversa", [], { sessao: "local_p" }),
  fake("21-10-2026 - 11h00 - Subagente - Ler", ["subagente"], { sessao: "agent-a", up: "[[21-10-2026 - 10h00 - Conversa]]" }),
  fake("21-10-2026 - 12h00 - Conversa (fork)", ["fork"], { sessao: "local_f", sessao_pai: "p" }),
];

describe("LogsView with fork logs (KAN-10)", () => {
  it("lists only the conversation, with one toggle for the subagents and another for the forks", async () => {
    const view = await openView(logs());
    expect(view.visible).toHaveLength(1);
    expect(byClass(view.contentEl, "ailm-sub-toggle")).toHaveLength(2);
    expect(byClass(view.contentEl, "ailm-fork-toggle")).toHaveLength(1);
  });

  it("opens the forks without opening the subagents", async () => {
    const view = await openView(logs());
    click(byClass(view.contentEl, "ailm-fork-toggle")[0]);
    expect(view.visible).toHaveLength(2);
    expect(byClass(view.contentEl, "ailm-row-fork")).toHaveLength(1);
    const names = view.visible.map((p: string) => p);
    expect(names.some((p: string) => p.includes("Subagente"))).toBe(false);
    expect(names.some((p: string) => p.includes("(fork)"))).toBe(true);
  });

  it("opens the group of a fork when the fork is chosen", async () => {
    const view = await openView(logs());
    const fork = view.records.find((r: { fork: boolean }) => r.fork);
    view.select(fork.path as string);
    expect(view.visible).toContain(fork.path);
    expect(view.visible).toHaveLength(2);
  });
});
