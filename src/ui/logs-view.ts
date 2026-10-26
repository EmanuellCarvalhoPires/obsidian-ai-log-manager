// The logs screen: list of logs (Claude and Antigravity) with filters and search, a preview that
// renders the note and follows the active conversation, and a side panel reserved for the
// repository graph (Phase 3).
import { Component, ItemView, MarkdownRenderer, Notice, TFile, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { collectLogSources } from "../adapters/log-sources";
import { buildIndex, distinct, filterLogs } from "../core/log-index";
import type { LogFilters, LogRecord } from "../core/log-index";
import type { DevService } from "../core/dev-service";
import type { ProjectTracker } from "../core/project-tracker";
import { startTimer, stopTimer } from "../core/timers";
import { t } from "../i18n";
import { renderGraphInto } from "./graph-block";
import { paginate, renderPaginationControls } from "./pagination";

export const LOGS_VIEW_TYPE = "ai-log-manager-logs";
const LIVE_WINDOW_MS = 3 * 60_000;

function dayStart(value: string): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).getTime() : undefined;
}

function dayEnd(value: string): number | undefined {
  const start = dayStart(value);
  return start === undefined ? undefined : start + 24 * 3600_000 - 1;
}

export interface LogsViewDeps {
  dev: () => DevService;
  tracker: () => ProjectTracker;
}

export class LogsView extends ItemView {
  private records: LogRecord[] = [];
  private filters: LogFilters = {};
  private selected: string | undefined;
  private follow = true;
  private page = 1;
  private refreshTimer: number | undefined;
  private renderTimer: number | undefined;
  private rendered: Component | undefined;
  private graphKey: string | undefined;

  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private tocEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private previewTitleEl!: HTMLElement;
  private graphEl!: HTMLElement;
  private selects: Record<"agent" | "project" | "status", HTMLSelectElement> | undefined;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: LogsViewDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return LOGS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("view.title");
  }

  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    try {
      await this.build();
    } catch (err) {
      console.error("[AI Log Manager] Could not open the logs screen", err);
      new Notice(`LogsView error: ${err instanceof Error ? err.message : String(err)}`, 20000);
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: "ailm-empty", text: `${t("view.failed")}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async build(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ailm-logs");
    this.buildToolbar(root.createDiv({ cls: "ailm-toolbar" }));

    const columns = root.createDiv({ cls: "ailm-columns" });
    const listCol = columns.createDiv({ cls: "ailm-col ailm-col-list" });
    this.countEl = listCol.createDiv({ cls: "ailm-count ailm-muted" });
    this.listEl = listCol.createDiv({ cls: "ailm-list" });

    const previewCol = columns.createDiv({ cls: "ailm-col ailm-col-preview" });
    const head = previewCol.createDiv({ cls: "ailm-preview-head" });
    this.previewTitleEl = head.createDiv({ cls: "ailm-preview-title" });
    const followLabel = head.createEl("label", { cls: "ailm-follow" });
    const follow = followLabel.createEl("input", { type: "checkbox" });
    follow.checked = this.follow;
    follow.addEventListener("change", () => (this.follow = follow.checked));
    const live = followLabel.createSpan({ cls: "ailm-follow-icon" });
    setIcon(live, "radio");
    followLabel.createSpan({ text: t("view.follow") });
    const open = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("view.openNote") } });
    setIcon(open, "external-link");
    open.addEventListener("click", () => void this.openSelected());
    this.tocEl = previewCol.createDiv({ cls: "ailm-toc" });
    this.previewEl = previewCol.createDiv({ cls: "ailm-preview markdown-rendered" });

    const graphCol = columns.createDiv({ cls: "ailm-col ailm-col-graph" });
    const graphHead = graphCol.createDiv({ cls: "ailm-preview-head" });
    setIcon(graphHead.createSpan({ cls: "ailm-follow-icon" }), "git-branch");
    graphHead.createDiv({ text: t("view.graph.title"), cls: "ailm-preview-title" });
    this.graphEl = graphCol.createDiv({ cls: "ailm-graph-panel" });
    this.graphEl.createDiv({ text: t("view.graph.pick"), cls: "ailm-empty ailm-muted" });

    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === this.selected) this.scheduleRender(true);
      }),
    );

    this.refresh();
    this.renderPreview(false);
  }

  onClose(): Promise<void> {
    if (this.refreshTimer !== undefined) stopTimer(this.refreshTimer);
    if (this.renderTimer !== undefined) stopTimer(this.renderTimer);
    this.rendered?.unload();
    return Promise.resolve();
  }

  /** Opens the screen with a log selected. */
  select(path: string): void {
    this.selected = path;
    this.renderList();
    this.renderPreview(false);
  }

  // ---- Toolbar and filters --------------------------------------------------

  private buildToolbar(bar: HTMLElement): void {
    const search = bar.createDiv({ cls: "ailm-search" });
    setIcon(search.createSpan({ cls: "ailm-search-icon" }), "search");
    const input = search.createEl("input", { type: "search", placeholder: t("view.search") });
    input.addEventListener("input", () => {
      this.filters.query = input.value;
      this.renderList();
    });

    const make = (key: "agent" | "project" | "status", label: string): HTMLSelectElement => {
      const sel = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": label } });
      sel.addEventListener("change", () => {
        this.filters[key] = sel.value === "" ? undefined : sel.value;
        this.renderList();
      });
      return sel;
    };
    this.selects = { agent: make("agent", t("view.filter.agent")), project: make("project", t("view.filter.project")), status: make("status", t("view.filter.status")) };

    const date = (label: string, apply: (v: string) => void): void => {
      const wrap = bar.createEl("label", { cls: "ailm-date" });
      wrap.createSpan({ text: label, cls: "ailm-muted" });
      const d = wrap.createEl("input", { type: "date" });
      d.addEventListener("change", () => {
        apply(d.value);
        this.page = 1;
        this.renderList();
      });
    };
    date(t("view.filter.from"), (v) => (this.filters.from = dayStart(v)));
    date(t("view.filter.to"), (v) => (this.filters.to = dayEnd(v)));
  }

  private fillSelect(sel: HTMLSelectElement, all: string, values: string[], label?: (v: string) => string): void {
    const current = sel.value;
    sel.empty();
    sel.createEl("option", { value: "", text: all });
    for (const v of values) sel.createEl("option", { value: v, text: label ? label(v) : v });
    sel.value = values.includes(current) ? current : "";
  }

  // ---- Index and list -------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) stopTimer(this.refreshTimer);
    this.refreshTimer = startTimer(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 500);
  }

  private refresh(): void {
    this.records = buildIndex(collectLogSources(this.app));
    if (this.selects) {
      this.fillSelect(this.selects.agent, t("view.filter.allAgents"), distinct(this.records, (r) => r.agent), (v) => this.agentLabel(v));
      this.fillSelect(this.selects.project, t("view.filter.allProjects"), distinct(this.records, (r) => r.project));
      this.fillSelect(this.selects.status, t("view.filter.allStatus"), distinct(this.records, (r) => r.status), (v) => this.statusLabel(v));
    }
    this.renderList();
  }

  private agentLabel(agent: string): string {
    return agent === "claude" ? "Claude" : agent === "gemini" ? "Antigravity" : agent;
  }

  private statusLabel(status: string): string {
    return status === "ativo" ? t("view.status.active") : status === "arquivado" ? t("view.status.archived") : status;
  }

  private renderList(): void {
    const shown = filterLogs(this.records, this.filters);
    this.countEl.setText(t("view.count", { shown: shown.length, total: this.records.length }));
    this.listEl.empty();
    if (shown.length === 0) {
      this.listEl.createDiv({ text: t("view.empty"), cls: "ailm-empty ailm-muted" });
      return;
    }
    const paginated = paginate(shown, this.page, 100);
    const now = Date.now();
    for (const r of paginated.pageItems) {
      const row = this.listEl.createDiv({ cls: "ailm-row" });
      if (r.path === this.selected) row.addClass("is-active");
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      const top = row.createDiv({ cls: "ailm-row-top" });
      const icon = top.createSpan({ cls: "ailm-row-icon" });
      setIcon(icon, r.agent === "gemini" ? "sparkles" : "bot");
      top.createSpan({ text: r.title, cls: "ailm-row-title" });
      if (r.status === "ativo" && now - r.mtime < LIVE_WINDOW_MS) {
        const live = top.createSpan({ cls: "ailm-live", attr: { "aria-label": t("view.live") } });
        setIcon(live, "radio");
      }
      const meta = row.createDiv({ cls: "ailm-row-meta ailm-muted" });
      meta.createSpan({ text: new Date(r.date).toLocaleString() });
      meta.createSpan({ text: this.agentLabel(r.agent) });
      if (r.project) meta.createSpan({ text: r.project });
      if (r.status !== "ativo") meta.createSpan({ text: this.statusLabel(r.status) });
      const choose = (): void => this.select(r.path);
      row.addEventListener("click", choose);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose();
        }
      });
    }

    renderPaginationControls(
      this.listEl,
      paginated.hasMore,
      paginated.shownCount,
      paginated.total,
      () => {
        this.page++;
        this.renderList();
      },
      { showMore: "Carregar mais" },
    );
  }

  // ---- Preview --------------------------------------------------------------

  private scheduleRender(fromChange: boolean): void {
    if (this.renderTimer !== undefined) stopTimer(this.renderTimer);
    this.renderTimer = startTimer(() => {
      this.renderTimer = undefined;
      this.renderPreview(fromChange);
    }, 400);
  }

  private renderPreview(fromChange: boolean): void {
    const record = this.records.find((r) => r.path === this.selected);
    const file = this.selected ? this.app.vault.getFileByPath(this.selected) : null;
    this.tocEl.empty();
    this.renderGraph(record);
    if (!record || !file) {
      this.previewTitleEl.setText("");
      this.previewEl.empty();
      this.previewEl.createDiv({ text: t("view.pick"), cls: "ailm-empty ailm-muted" });
      return;
    }
    this.previewTitleEl.setText(record.title);
    void this.renderFile(file, record, fromChange);
  }

  private renderGraph(record: LogRecord | undefined): void {
    if (this.graphKey === (record?.project ?? "")) return;
    this.graphKey = record?.project ?? "";
    this.graphEl.empty();
    if (!record) {
      this.graphEl.createDiv({ text: t("view.graph.pick"), cls: "ailm-empty ailm-muted" });
      return;
    }
    void renderGraphInto(this.graphEl, this.deps.dev(), this.deps.tracker(), { projeto: record.project, width: 300 });
  }

  private async renderFile(file: TFile, record: LogRecord, fromChange: boolean): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    if (file.path !== this.selected) return;
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    this.rendered?.unload();
    const component = new Component();
    component.load();
    this.rendered = component;
    const scrollTop = this.previewEl.scrollTop;
    this.previewEl.empty();
    await MarkdownRenderer.render(this.app, body, this.previewEl, file.path, component);

    this.tocEl.empty();
    for (const heading of record.entries) {
      const chip = this.tocEl.createEl("button", { cls: "ailm-toc-item", text: heading });
      chip.addEventListener("click", () => this.scrollToHeading(heading));
    }
    if (fromChange && this.follow) this.previewEl.scrollTo({ top: this.previewEl.scrollHeight });
    else if (fromChange) this.previewEl.scrollTo({ top: scrollTop });
  }

  private scrollToHeading(heading: string): void {
    const found = Array.from(this.previewEl.querySelectorAll("h2")).find((h) => (h.getAttribute("data-heading") ?? h.textContent) === heading);
    if (found) found.scrollIntoView({ block: "start", behavior: "smooth" });
    else new Notice(t("view.noHeading"));
  }

  private async openSelected(): Promise<void> {
    const file = this.selected ? this.app.vault.getFileByPath(this.selected) : null;
    if (file) await this.app.workspace.getLeaf("tab").openFile(file);
  }
}
