// Draws a repository graph (an SVG string from the core) inside an element, without innerHTML.
import type { App } from "obsidian";
import { parseGraphBlock } from "../core/dev-events";
import type { DevService } from "../core/dev-service";
import type { ProjectTracker } from "../core/project-tracker";
import { t } from "../i18n";

export function appendSvg(parent: HTMLElement, svg: string): void {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== "svg") return;
  parent.appendChild(parent.ownerDocument.importNode(root, true));
}

/** Renders the graph of a project into `el`; returns false when there is nothing to draw. */
export async function renderGraphInto(
  el: HTMLElement,
  dev: DevService,
  tracker: ProjectTracker,
  options: { projeto?: string; branch?: string; hash?: string; limite?: number; width?: number },
): Promise<boolean> {
  el.empty();
  const project = options.projeto ? await tracker.byName(options.projeto) : undefined;
  if (!project) {
    el.createDiv({ text: t("graph.noProject"), cls: "ailm-empty ailm-muted" });
    return false;
  }
  try {
    const g = await dev.graph(project, { limit: options.limite, width: options.width, highlight: { branch: options.branch, hash: options.hash } });
    if (g.rows.length === 0) {
      el.createDiv({ text: t("graph.empty"), cls: "ailm-empty ailm-muted" });
      return false;
    }
    appendSvg(el.createDiv({ cls: "ailm-graph" }), g.svg);
    return true;
  } catch (err) {
    el.createDiv({ text: t("graph.failed", { reason: err instanceof Error ? err.message : String(err) }), cls: "ailm-empty ailm-muted" });
    return false;
  }
}

/** Processor of the ```ai-log-graph code block that event notes carry. */
export function registerGraphBlock(
  register: (language: string, handler: (source: string, el: HTMLElement) => void | Promise<void>) => unknown,
  _app: App,
  dev: () => DevService,
  tracker: () => ProjectTracker,
): void {
  register("ai-log-graph", async (source, el) => {
    const params = parseGraphBlock(source);
    const box = el.createDiv({ cls: "ailm-graph-block" });
    await renderGraphInto(box, dev(), tracker(), { ...params, width: 360 });
  });
}
