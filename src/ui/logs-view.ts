// The logs screen: list of logs (Claude and Antigravity) grouped by day, with search and filters, a timeline of
// the turns and the reading area, in resizable columns that can be hidden.
//
// Design rule of this screen: nothing blocks, nothing blanks and nothing jumps. A click is answered in the same
// frame (the row lights up and the header of the log changes at once), what was on screen stays until the new
// content is ready, and notes already read come back from a small cache with their scroll position.
import { Component, ItemView, MarkdownRenderer, Notice, TFile, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { collectLogSources } from "../adapters/log-sources";
import { AGENT_TAGS, buildIndex, filterLogs, forkRootOf, groupLogs } from "../core/log-index";
import type { LogFilters, LogRecord } from "../core/log-index";
import type { SourceFile } from "../core/log-source-file";
import { startTimer, stopTimer } from "../core/timers";
import { t } from "../i18n";
import { agentLogo } from "../ui-agent-logos";
import { renderJsonl } from "./jsonl-view";
import { openSourceFile, showLogMenu } from "./log-menu";
import { paginate, renderPaginationControls } from "./pagination";

/** What the screen needs from the plugin. */
export interface LogsViewHost {
  /** Transcript (.jsonl) or Antigravity conversation (.db) of a log, by the path of its note. */
  resolveSource(path: string, record?: LogRecord): Promise<SourceFile | undefined>;
  /** Text of a transcript file. */
  readText(path: string): Promise<string>;
}

const NO_HOST: LogsViewHost = { resolveSource: () => Promise.resolve(undefined), readText: () => Promise.resolve("") };

export const LOGS_VIEW_TYPE = "ai-log-manager-logs";
const LIVE_WINDOW_MS = 3 * 60_000;
const LAYOUT_KEY = "ai-log-manager-layout";
/** Notes kept rendered, so coming back to one is instant. */
const CACHE_SIZE = 8;
/** Typing in the search box waits this long, so a burst of keys draws the list once. */
const SEARCH_DELAY_MS = 70;
/** Moving through the list with the arrow keys waits this long before drawing the note. */
const KEY_DELAY_MS = 70;
/** After a click on the timeline, scrolling does not move the highlight (the click already chose it). */
const RAIL_LOCK_MS = 700;
/** Least width the text keeps; below it the turns column folds away by itself. */
const MIN_READING_PX = 400;

interface Layout {
  list: number;
  rail: number;
  showList: boolean;
  showRail: boolean;
  /** What the reading area shows: the Markdown log or the JSONL transcript. */
  mode: "md" | "jsonl";
}

const DEFAULT_LAYOUT: Layout = { list: 300, rail: 200, showList: true, showRail: true, mode: "md" };

/** A note already rendered: its nodes, the component that owns them and where the reader stopped. */
interface RenderedNote {
  holder: HTMLElement;
  component: Component;
  mtime: number;
  entries: string[];
  scroll: number;
}

function dayStart(value: string): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).getTime() : undefined;
}

function dayEnd(value: string): number | undefined {
  const start = dayStart(value);
  return start === undefined ? undefined : start + 24 * 3600_000 - 1;
}

/** "Today", "Yesterday", or the date written out ("sexta-feira, 6 de novembro"). */
function dayLabel(epoch: number, now: number): string {
  const day = new Date(epoch);
  const today = new Date(now);
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((midnight(today) - midnight(day)) / 86_400_000);
  if (diff === 0) return t("view.day.today");
  if (diff === 1) return t("view.day.yesterday");
  const sameYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}

function timeLabel(epoch: number): string {
  return new Date(epoch).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export class LogsView extends ItemView {
  private records: LogRecord[] = [];
  private filters: LogFilters = {};
  private selected: string | undefined;
  private layout: Layout = { ...DEFAULT_LAYOUT };
  private page = 1;
  private refreshTimer: number | undefined;
  private renderTimer: number | undefined;
  private listTimer: number | undefined;
  /** Counts the draws of the reading area; a draw that finds a newer number gives up. */
  private renderSeq = 0;
  /** Path of the note on screen, when the Markdown tab shows one. */
  private mountedPath: string | undefined;
  /** Whether the reading area holds a document (so a new one only dims it, instead of showing placeholders). */
  private hasContent = false;
  private railLockUntil = 0;
  private justOpened: string | undefined;
  private observer: IntersectionObserver | undefined;
  private agentsKey = "";
  private readonly cache = new Map<string, RenderedNote>();
  private readonly rowEls = new Map<string, HTMLElement>();
  /** Paths of the rows on screen, top to bottom (the arrow keys walk this list). */
  private visible: string[] = [];

  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private tocEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private headEl!: HTMLElement;
  private columnsEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private clearEl!: HTMLElement;
  private agentsEl!: HTMLElement;
  private readonly tabButtons: HTMLElement[] = [];
  private readonly agentButtons = new Map<string, HTMLElement>();
  /** Conversation logs whose subagent logs are open in the list. */
  private readonly expanded = new Set<string>();
  /** Conversation logs whose fork logs are open in the list (a group apart from the subagents, KAN-10). */
  private readonly expandedForks = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: LogsViewHost = NO_HOST,
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

    this.loadLayout();
    const columns = root.createDiv({ cls: "ailm-columns" });
    this.columnsEl = columns;
    // Each column carries its own hide button in its header; hidden columns come back from the dock.
    const listCol = columns.createDiv({ cls: "ailm-col ailm-col-list" });
    const listHead = listCol.createDiv({ cls: "ailm-col-head" });
    this.countEl = listHead.createDiv({ cls: "ailm-count ailm-muted", attr: { "aria-live": "polite" } });
    this.iconButton(listHead, "panel-left-close", t("view.hideList"), () => this.toggle("showList"));
    this.listEl = listCol.createDiv({ cls: "ailm-list", attr: { role: "list" } });
    this.listEl.addEventListener("keydown", (e) => this.onListKey(e));
    this.makeHandle(columns, "list");

    const railCol = columns.createDiv({ cls: "ailm-col ailm-col-rail" });
    const railHead = railCol.createDiv({ cls: "ailm-col-head" });
    railHead.createDiv({ cls: "ailm-count ailm-muted", text: t("view.turns") });
    this.iconButton(railHead, "panel-left-close", t("view.hideRail"), () => this.toggle("showRail"));
    this.tocEl = railCol.createEl("nav", { cls: "ailm-rail is-empty", attr: { "aria-label": t("view.turns") } });
    this.makeHandle(columns, "rail");

    const reading = columns.createDiv({ cls: "ailm-reading" });
    // Top of the reading area: the tabs "Log Markdown" / "Log JSONL", then the title and facts of the log.
    const bar = reading.createDiv({ cls: "ailm-tabbar" });
    const dock = bar.createDiv({ cls: "ailm-dock" });
    this.iconButton(dock, "panel-left-open", t("view.showList"), () => this.toggle("showList"), "ailm-dock-list");
    this.iconButton(dock, "list-tree", t("view.showRail"), () => this.toggle("showRail"), "ailm-dock-rail");
    this.tabsEl = bar.createDiv({ cls: "ailm-tabs", attr: { role: "tablist" } });
    this.tab("md", "file-text", t("view.tab.markdown"));
    this.tab("jsonl", "braces", t("view.tab.jsonl"));
    this.iconButton(bar, "external-link", t("view.openNote"), () => void this.openSelected(), "ailm-open");
    this.headEl = reading.createDiv({ cls: "ailm-doc-head is-empty" });
    this.previewEl = reading.createDiv({ cls: "ailm-preview markdown-rendered" });
    this.previewEl.addEventListener("scroll", () => this.markCurrentTurn(), { passive: true });
    this.applyLayout();
    this.updateTabs();
    // The first layout is drawn as it is; only later changes animate.
    columns.addClass("is-resizing");
    startTimer(() => columns.removeClass("is-resizing"), 80);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.applyLayout());
      observer.observe(columns);
      this.register(() => observer.disconnect());
    }

    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === this.selected && this.layout.mode === "md") this.scheduleRender(true);
      }),
    );

    this.refresh();
    this.renderPreview(false);
  }

  onClose(): Promise<void> {
    for (const timer of [this.refreshTimer, this.renderTimer, this.listTimer]) if (timer !== undefined) stopTimer(timer);
    this.observer?.disconnect();
    for (const entry of this.cache.values()) entry.component.unload();
    this.cache.clear();
    return Promise.resolve();
  }

  /**
   * Opens the screen with a log selected. The row lights up and the header changes at once; the note is drawn
   * right after (`defer` waits a moment, for the arrow keys held down).
   */
  select(path: string, defer = false): void {
    if (path === this.selected) return;
    this.selected = path;
    const picked = this.records.find((r) => r.path === path);
    const parent = picked?.subagent && picked.parent ? this.records.find((r) => !r.subagent && r.name === picked.parent) : undefined;
    const forkRoot = picked?.fork ? forkRootOf(picked, this.records) : undefined;
    if (parent && !this.expanded.has(parent.path)) {
      this.expanded.add(parent.path);
      this.renderList();
    } else if (forkRoot && !this.expandedForks.has(forkRoot.path)) {
      this.expandedForks.add(forkRoot.path);
      this.renderList();
    } else this.markActive();
    this.rowEls.get(path)?.scrollIntoView({ block: "nearest" });
    this.renderHead(picked);
    if (defer) this.scheduleRender(false, KEY_DELAY_MS);
    else this.renderPreview(false);
  }

  // ---- Toolbar and filters --------------------------------------------------

  private buildToolbar(bar: HTMLElement): void {
    const search = bar.createDiv({ cls: "ailm-search" });
    setIcon(search.createSpan({ cls: "ailm-search-icon" }), "search");
    const input = search.createEl("input", { type: "search", placeholder: t("view.search"), attr: { "aria-label": t("view.search") } });
    this.clearEl = this.iconButton(search, "x", t("view.search.clear"), () => {
      input.value = "";
      this.applyQuery("", true);
      input.focus();
    }, "ailm-search-clear");
    this.clearEl.addClass("is-hidden");
    input.addEventListener("input", () => this.applyQuery(input.value, false));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value !== "") {
        e.preventDefault();
        input.value = "";
        this.applyQuery("", true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const first = this.visible[0];
        if (first) this.rowEls.get(this.selected && this.visible.includes(this.selected) ? this.selected : first)?.focus();
      }
    });

    this.agentsEl = bar.createDiv({ cls: "ailm-segmented is-hidden", attr: { role: "group", "aria-label": t("view.filter.agent") } });

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

  /** The search box: the clear button answers at once, the list is drawn once the typing pauses. */
  private applyQuery(value: string, immediate: boolean): void {
    this.filters.query = value;
    this.clearEl.toggleClass("is-hidden", value === "");
    this.page = 1;
    if (this.listTimer !== undefined) stopTimer(this.listTimer);
    if (immediate) {
      this.listTimer = undefined;
      this.renderList();
      return;
    }
    this.listTimer = startTimer(() => {
      this.listTimer = undefined;
      this.renderList();
    }, SEARCH_DELAY_MS);
  }

  /** One button per agent that has logs, plus "All"; hidden while there is only one agent to choose. */
  private renderAgentFilter(): void {
    // Only real agents get a button: notes with other tags (a ticket summary, a MOC) fall back to that tag as "agent".
    const agents = [...new Set(this.records.map((r) => r.agent))].filter((a) => AGENT_TAGS.includes(a)).sort((a, b) => a.localeCompare(b));
    const key = agents.join("|");
    if (key !== this.agentsKey) {
      this.agentsKey = key;
      this.agentsEl.empty();
      this.agentButtons.clear();
      if (this.filters.agent && !agents.includes(this.filters.agent)) this.filters.agent = undefined;
      this.agentsEl.toggleClass("is-hidden", agents.length < 2);
      if (agents.length >= 2) {
        const add = (agent: string, label: string, icon: string | undefined): void => {
          const button = this.agentsEl.createEl("button", { cls: "ailm-seg", attr: { "aria-pressed": "false" } });
          if (icon) setIcon(button.createSpan({ cls: "ailm-seg-icon" }), icon);
          button.createSpan({ text: label });
          button.addEventListener("click", () => {
            this.filters.agent = agent === "" ? undefined : agent;
            this.page = 1;
            this.updateAgentFilter();
            this.renderList();
          });
          this.agentButtons.set(agent, button);
        };
        add("", t("view.filter.all"), undefined);
        for (const agent of agents) add(agent, this.agentLabel(agent), agentLogo(agent));
      }
    }
    this.updateAgentFilter();
  }

  private updateAgentFilter(): void {
    for (const [agent, button] of this.agentButtons) {
      const on = agent === (this.filters.agent ?? "");
      button.toggleClass("is-active", on);
      button.setAttribute("aria-pressed", String(on));
    }
  }

  // ---- Tabs: Markdown log / JSONL transcript -------------------------------------

  private tab(mode: Layout["mode"], icon: string, label: string): void {
    const el = this.tabsEl.createEl("button", { cls: "ailm-tab", attr: { role: "tab", "data-mode": mode } });
    this.tabButtons.push(el);
    setIcon(el.createSpan({ cls: "ailm-tab-icon" }), icon);
    el.createSpan({ text: label });
    el.addEventListener("click", () => {
      if (this.layout.mode === mode) return;
      this.layout.mode = mode;
      this.saveLayout();
      this.updateTabs();
      this.renderPreview(false);
    });
  }

  private updateTabs(): void {
    this.tabButtons.forEach((el) => {
      const on = el.getAttribute("data-mode") === this.layout.mode;
      el.toggleClass("is-active", on);
      el.setAttribute("aria-selected", String(on));
    });
    this.columnsEl.toggleClass("mode-jsonl", this.layout.mode === "jsonl");
    // The turns of a Markdown log mean nothing next to the transcript: the column folds away on its own.
    this.applyLayout();
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
    this.renderAgentFilter();
    this.renderList();
    // The title, project or status of the open log may have changed.
    this.renderHead(this.records.find((r) => r.path === this.selected));
  }

  private agentLabel(agent: string): string {
    return agent === "claude" ? "Claude" : agent === "gemini" ? "Antigravity" : agent;
  }

  private statusLabel(status: string): string {
    return status === "ativo" ? t("view.status.active") : status === "arquivado" ? t("view.status.archived") : status;
  }

  private emptyState(parent: HTMLElement, icon: string, title: string, hint?: string): void {
    const box = parent.createDiv({ cls: "ailm-empty" });
    setIcon(box.createDiv({ cls: "ailm-empty-icon" }), icon);
    box.createDiv({ cls: "ailm-empty-title", text: title });
    if (hint) box.createDiv({ cls: "ailm-empty-hint", text: hint });
  }

  /** Grey bars where the text will be, shown only while the first note of the session loads. */
  private skeleton(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "ailm-skeleton", attr: { "aria-hidden": "true" } });
    for (const width of ["38%", "92%", "84%", "88%", "46%", "90%", "72%"]) {
      box.createDiv({ cls: "ailm-skeleton-line" }).setCssProps({ width });
    }
  }

  private renderList(): void {
    const shown = filterLogs(this.records, this.filters);
    this.countEl.setText(t("view.count", { shown: shown.length, total: this.records.length }));
    this.observer?.disconnect();
    this.observer = undefined;
    // Emptying the list resets its scroll; keep the position so selecting a log does not make the list jump.
    const scrollTop = this.listEl.scrollTop;
    this.listEl.empty();
    this.rowEls.clear();
    this.visible = [];
    if (shown.length === 0) {
      this.emptyState(this.listEl, "search-x", t("view.empty"), t("view.empty.hint"));
      return;
    }
    const groups = groupLogs(shown, this.records);
    const paginated = paginate(groups, this.page, 100);
    const searching = !!this.filters.query?.trim();
    const now = Date.now();
    let day = "";
    for (const group of paginated.pageItems) {
      const r = group.record;
      const label = dayLabel(r.date, now);
      if (label !== day) {
        day = label;
        this.listEl.createDiv({ cls: "ailm-day", text: label, attr: { role: "presentation" } });
      }
      const open = group.children.length > 0 && (searching || this.expanded.has(r.path));
      const forksOpen = group.forks.length > 0 && (searching || this.expandedForks.has(r.path));
      this.renderRow(r, now, {
        subagents: group.children.length > 0 ? { count: group.children.length, open } : undefined,
        forks: group.forks.length > 0 ? { count: group.forks.length, open: forksOpen } : undefined,
      });
      if (open) for (const child of group.children) this.renderRow(child, now, undefined, this.justOpened === r.path);
      if (forksOpen) for (const fork of group.forks) this.renderRow(fork, now, undefined, this.justOpened === `${r.path}#fork`);
    }
    this.justOpened = undefined;

    const footer = renderPaginationControls(
      this.listEl,
      paginated.hasMore,
      paginated.shownCount,
      paginated.total,
      () => {
        this.page++;
        this.renderList();
      },
      { showMore: t("view.loadMore") },
    );
    this.listEl.scrollTop = scrollTop;
    // The next page loads by itself when the reader gets to the end of the list.
    if (footer && paginated.hasMore && typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (hits) => {
          if (!hits.some((h) => h.isIntersecting)) return;
          observer.disconnect();
          this.page++;
          this.renderList();
        },
        { root: this.listEl, rootMargin: "160px" },
      );
      observer.observe(footer);
      this.observer = observer;
    }
  }

  /**
   * One log of the list; a conversation with subagent logs or fork logs also gets a button for each of those groups
   * that opens them below it. The two groups open apart from each other.
   */
  private renderRow(
    r: LogRecord,
    now: number,
    groups?: { subagents?: { count: number; open: boolean }; forks?: { count: number; open: boolean } },
    entering = false,
  ): void {
    const row = this.listEl.createDiv({ cls: "ailm-row", attr: { "data-agent": r.agent, role: "listitem", tabindex: "0" } });
    if (r.subagent || r.fork) row.addClass("ailm-row-child");
    if (r.fork) row.addClass("ailm-row-fork");
    if (entering) row.addClass("ailm-enter");
    if (r.path === this.selected) {
      row.addClass("is-active");
      row.setAttribute("aria-current", "true");
    }
    this.rowEls.set(r.path, row);
    this.visible.push(r.path);

    const label = this.agentLabel(r.agent);
    const avatar = row.createSpan({ cls: "ailm-avatar", attr: { title: label, "aria-label": label } });
    setIcon(avatar, r.subagent ? "corner-down-right" : r.fork ? "git-fork" : (agentLogo(r.agent) ?? "bot"));
    const body = row.createDiv({ cls: "ailm-row-body" });
    const top = body.createDiv({ cls: "ailm-row-top" });
    top.createSpan({ text: r.title, cls: "ailm-row-title" });
    if (r.status === "ativo" && now - r.mtime < LIVE_WINDOW_MS) {
      top.createSpan({ cls: "ailm-live", attr: { "aria-label": t("view.live"), title: t("view.live") } });
    }
    if (groups?.subagents || groups?.forks) {
      const toggles = top.createDiv({ cls: "ailm-sub-toggles" });
      const addToggle = (group: { count: number; open: boolean }, text: string, set: Set<string>, openKey: string, extraCls: string, icon?: string): void => {
        const toggle = toggles.createEl("button", { cls: `ailm-sub-toggle clickable-icon ${extraCls}`.trim(), attr: { "aria-label": text, "aria-expanded": String(group.open), title: text } });
        setIcon(toggle.createSpan({ cls: "ailm-sub-icon" }), "chevron-right");
        if (icon) setIcon(toggle.createSpan({ cls: "ailm-sub-kind" }), icon);
        toggle.createSpan({ cls: "ailm-sub-count", text: String(group.count) });
        toggle.toggleClass("is-open", group.open);
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (set.has(r.path)) set.delete(r.path);
          else {
            set.add(r.path);
            this.justOpened = openKey;
          }
          this.renderList();
        });
      };
      if (groups.subagents) addToggle(groups.subagents, t("view.subagents.count", { count: groups.subagents.count }), this.expanded, r.path, "");
      if (groups.forks) addToggle(groups.forks, t("view.forks.count", { count: groups.forks.count }), this.expandedForks, `${r.path}#fork`, "ailm-fork-toggle", "git-fork");
    }
    const meta = body.createDiv({ cls: "ailm-row-meta" });
    meta.createSpan({ text: timeLabel(r.date), cls: "ailm-row-time" });
    if (r.subagent) meta.createSpan({ text: t("view.subagent"), cls: "ailm-tag" });
    else if (r.fork) meta.createSpan({ text: t("view.fork"), cls: "ailm-tag" });
    if (r.project) meta.createSpan({ text: r.project, cls: "ailm-tag ailm-tag-project" });
    if (r.status !== "ativo") meta.createSpan({ text: this.statusLabel(r.status), cls: "ailm-tag" });

    row.addEventListener("click", () => this.select(r.path));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showLogMenu({ app: this.app, resolveSource: (p) => this.host.resolveSource(p, this.records.find((x) => x.path === p)) }, r.path, e);
    });
  }

  /** The row of the chosen log lights up without drawing the list again, so the list never jumps. */
  private markActive(): void {
    for (const [path, el] of this.rowEls) {
      const on = path === this.selected;
      el.toggleClass("is-active", on);
      if (on) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
    }
  }

  /** Arrow keys walk the list; Enter or Space picks the focused log. */
  private onListKey(e: KeyboardEvent): void {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".ailm-row");
    if (!row || e.target !== row) return;
    const current = this.visible.find((p) => this.rowEls.get(p) === row);
    if (current === undefined) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.select(current);
      return;
    }
    const at = this.visible.indexOf(current);
    const next =
      e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? this.visible.length - 1 : undefined;
    if (next === undefined) return;
    e.preventDefault();
    const path = this.visible[Math.min(this.visible.length - 1, Math.max(0, next))];
    if (path === undefined) return;
    this.select(path, true);
    this.rowEls.get(path)?.focus();
  }

  // ---- Header of the open log -----------------------------------------------

  private renderHead(record: LogRecord | undefined): void {
    this.headEl.empty();
    this.headEl.toggleClass("is-empty", !record);
    if (!record) return;
    const label = this.agentLabel(record.agent);
    this.headEl.setAttribute("data-agent", record.agent);
    const avatar = this.headEl.createSpan({ cls: "ailm-avatar", attr: { title: label, "aria-label": label } });
    setIcon(avatar, record.subagent ? "corner-down-right" : record.fork ? "git-fork" : (agentLogo(record.agent) ?? "bot"));
    const text = this.headEl.createDiv({ cls: "ailm-doc-text" });
    text.createDiv({ cls: "ailm-doc-title", text: record.title, attr: { title: record.title } });
    const meta = text.createDiv({ cls: "ailm-doc-meta" });
    meta.createSpan({ text: new Date(record.date).toLocaleString() });
    meta.createSpan({ text: label });
    if (record.entries.length > 0) meta.createSpan({ text: t("view.turns.count", { count: record.entries.length }) });
    if (record.project) meta.createSpan({ text: record.project, cls: "ailm-tag ailm-tag-project" });
    if (record.status !== "ativo") meta.createSpan({ text: this.statusLabel(record.status), cls: "ailm-tag" });
    if (record.status === "ativo" && Date.now() - record.mtime < LIVE_WINDOW_MS) {
      const live = meta.createSpan({ cls: "ailm-doc-live" });
      live.createSpan({ cls: "ailm-live" });
      live.createSpan({ text: t("view.live") });
    }
  }

  // ---- Reading area -----------------------------------------------------------

  private scheduleRender(fromChange: boolean, delay = 400): void {
    if (this.renderTimer !== undefined) stopTimer(this.renderTimer);
    this.renderTimer = startTimer(() => {
      this.renderTimer = undefined;
      this.renderPreview(fromChange);
    }, delay);
  }

  /** Remembers where the reader stopped in the note on screen. */
  private saveScroll(): void {
    const entry = this.mountedPath ? this.cache.get(this.mountedPath) : undefined;
    if (entry && entry.holder.parentElement === this.previewEl) entry.scroll = this.previewEl.scrollTop;
  }

  private renderPreview(fromChange: boolean): void {
    if (this.renderTimer !== undefined && !fromChange) {
      stopTimer(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.saveScroll();
    const seq = ++this.renderSeq;
    const record = this.records.find((r) => r.path === this.selected);
    const file = this.selected ? this.app.vault.getFileByPath(this.selected) : null;
    if (!record || !file) {
      this.showPick();
      return;
    }
    if (this.layout.mode === "jsonl") void this.renderJsonlFile(record, seq);
    else void this.renderFile(file, record, fromChange, seq);
  }

  /** Nothing selected: an invitation to pick a log. */
  private showPick(): void {
    this.mountedPath = undefined;
    this.hasContent = false;
    this.tocEl.empty();
    this.tocEl.addClass("is-empty");
    this.previewEl.removeClass("is-loading");
    this.previewEl.empty();
    this.emptyState(this.previewEl, "scroll-text", t("view.pick"), t("view.pick.hint"));
  }

  /** While a new document loads, the one on screen stays and dims; on a blank screen, bars stand where the text will be. */
  private startLoading(): void {
    this.tocEl.addClass("is-empty");
    if (this.hasContent) {
      this.previewEl.addClass("is-loading");
      return;
    }
    this.previewEl.empty();
    this.skeleton(this.previewEl);
  }

  /** Puts a finished document on screen, with a short fade (never when the same note only refreshed). */
  private show(content: HTMLElement, scroll: number, fade: boolean): void {
    this.previewEl.removeClass("is-loading");
    this.previewEl.empty();
    this.previewEl.appendChild(content);
    // "instant" overrides the smooth scrolling of the stylesheet: coming back to a note must not visibly scroll.
    this.previewEl.scrollTo({ top: scroll, behavior: "instant" });
    this.hasContent = true;
    if (fade) {
      content.removeClass("ailm-fade");
      content.addClass("ailm-fade");
    }
  }

  /** The "Log JSONL" tab: the transcript of Claude Code, line by line. */
  private async renderJsonlFile(record: LogRecord, seq: number): Promise<void> {
    this.mountedPath = undefined;
    this.startLoading();
    const stale = (): boolean => seq !== this.renderSeq;
    const holder = createDiv({ cls: "ailm-jsonl-wrap" });
    const finish = (): void => this.show(holder, 0, true);

    const source = await this.host.resolveSource(record.path, record);
    if (stale()) return;
    if (!source) {
      this.emptyState(holder, "file-question", t("view.jsonl.missing"));
      return finish();
    }
    if (source.kind === "db") {
      this.emptyState(holder, "database", t("view.jsonl.db"));
      this.iconButton(holder, "folder-open", t("menu.openJsonl"), () => void openSourceFile({ app: this.app, resolveSource: () => Promise.resolve(source) }, record.path), "ailm-empty-action");
      return finish();
    }
    let text: string;
    try {
      text = await this.host.readText(source.path);
    } catch (err) {
      if (stale()) return;
      this.emptyState(holder, "triangle-alert", `${t("view.jsonl.failed")}: ${err instanceof Error ? err.message : String(err)}`);
      return finish();
    }
    if (stale()) return;
    renderJsonl(holder, text, { loadMore: t("view.jsonl.more"), empty: t("view.jsonl.empty"), lines: t("view.jsonl.lines") });
    finish();
  }

  private async renderFile(file: TFile, record: LogRecord, fromChange: boolean, seq: number): Promise<void> {
    const cached = this.cache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) {
      // Read before: back from memory, with the reader where they stopped.
      this.cache.delete(file.path);
      this.cache.set(file.path, cached);
      this.mount(file.path, cached, cached.scroll, true);
      return;
    }

    this.startLoading();
    const content = await this.app.vault.cachedRead(file);
    if (seq !== this.renderSeq) return;
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    const holder = createDiv({ cls: "ailm-doc" });
    const component = new Component();
    component.load();
    await MarkdownRenderer.render(this.app, body, holder, file.path, component);
    if (seq !== this.renderSeq) {
      component.unload();
      return;
    }
    // A note that is being written keeps the reader's place; a different one starts at the top.
    const scroll = fromChange && this.mountedPath === file.path ? this.previewEl.scrollTop : 0;
    this.remember(file.path, { holder, component, mtime: file.stat.mtime, entries: record.entries, scroll });
    const entry = this.cache.get(file.path);
    if (entry) this.mount(file.path, entry, scroll, !fromChange);
  }

  /** Keeps a rendered note in the cache; the oldest one goes when there are too many. */
  private remember(path: string, entry: RenderedNote): void {
    this.cache.get(path)?.component.unload();
    this.cache.delete(path);
    this.cache.set(path, entry);
    for (const [key, old] of this.cache) {
      if (this.cache.size <= CACHE_SIZE) break;
      if (key === path) continue;
      old.component.unload();
      this.cache.delete(key);
    }
  }

  private mount(path: string, entry: RenderedNote, scroll: number, fade: boolean): void {
    this.mountedPath = path;
    this.show(entry.holder, scroll, fade);
    this.renderRail(entry.entries);
    this.markCurrentTurn();
  }

  /** Vertical timeline of the turns, grouped by day: "16:12  Avalia esse plano". */
  private renderRail(entries: string[]): void {
    this.tocEl.empty();
    this.tocEl.toggleClass("is-empty", entries.length === 0);
    let day = "";
    for (const heading of entries) {
      const m = /^(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}:\d{2})\s*-?\s*(.*)$/.exec(heading);
      const date = m?.[1] ?? "";
      if (date && date !== day) {
        day = date;
        this.tocEl.createDiv({ cls: "ailm-rail-day", text: date });
      }
      const item = this.tocEl.createDiv({ cls: "ailm-rail-item", attr: { role: "button", tabindex: "0", "data-heading": heading, title: heading } });
      if (m) {
        item.createSpan({ cls: "ailm-rail-time", text: m[2] ?? "" });
        item.createSpan({ cls: "ailm-rail-text", text: m[3] || heading });
      } else item.createSpan({ cls: "ailm-rail-text", text: heading });
      const go = (): void => this.goToTurn(heading);
      item.addEventListener("click", go);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
    }
  }

  /** A click on a turn lights it at once and scrolls to it; the scroll does not take the highlight away on the way. */
  private goToTurn(heading: string): void {
    this.railLockUntil = Date.now() + RAIL_LOCK_MS;
    this.highlightTurn(heading);
    this.scrollToHeading(heading);
  }

  private highlightTurn(current: string | null): void {
    this.tocEl.querySelectorAll<HTMLElement>(".ailm-rail-item").forEach((el) => {
      const on = current !== null && el.getAttribute("data-heading") === current;
      el.toggleClass("is-current", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  }

  /** Highlights in the rail the turn being read (last heading above the top of the preview). */
  private markCurrentTurn(): void {
    if (Date.now() < this.railLockUntil) return;
    const top = this.previewEl.getBoundingClientRect().top + 24;
    let current: string | null = null;
    for (const h of Array.from(this.previewEl.querySelectorAll("h2"))) {
      if (h.getBoundingClientRect().top > top) break;
      current = h.getAttribute("data-heading") ?? h.textContent;
    }
    this.highlightTurn(current);
  }

  private scrollToHeading(heading: string): void {
    const found = Array.from(this.previewEl.querySelectorAll("h2")).find((h) => (h.getAttribute("data-heading") ?? h.textContent) === heading);
    if (found) found.scrollIntoView({ block: "start", behavior: "smooth" });
    else new Notice(t("view.noHeading"));
  }

  // ---- Column layout ---------------------------------------------------------

  private loadLayout(): void {
    const saved = this.app.loadLocalStorage(LAYOUT_KEY) as Partial<Layout> | null;
    this.layout = { ...DEFAULT_LAYOUT, ...(saved ?? {}) };
  }

  private saveLayout(): void {
    this.app.saveLocalStorage(LAYOUT_KEY, this.layout);
  }

  /**
   * Column widths go to CSS variables. A hidden column (or the turns, in the JSONL tab) shrinks to zero width, which
   * the grid animates; the `-px` variables keep its content at full width so it is clipped, not squeezed.
   */
  private applyLayout(): void {
    const c = this.columnsEl;
    const { showList, showRail } = this.layout;
    // In a narrow pane the turns give their room to the text (the reader's own choice stays saved).
    const total = c.clientWidth;
    const room = total - (showList ? this.layout.list + 5 : 0) - this.layout.rail - 5;
    const squeezed = total > 0 && room < MIN_READING_PX;
    const railOn = showRail && this.layout.mode === "md" && !squeezed;
    c.setCssProps({
      "--ailm-list-px": `${this.layout.list}px`,
      "--ailm-rail-px": `${this.layout.rail}px`,
      "--ailm-list-w": showList ? `${this.layout.list}px` : "0px",
      "--ailm-list-h": showList ? "5px" : "0px",
      "--ailm-rail-w": railOn ? `${this.layout.rail}px` : "0px",
      "--ailm-rail-h": railOn ? "5px" : "0px",
    });
    c.toggleClass("hide-list", !showList);
    c.toggleClass("hide-rail", !railOn);
    c.toggleClass("rail-hidden-by-user", !showRail);
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls = ""): HTMLElement {
    const b = parent.createEl("button", { cls: `clickable-icon ailm-icon-btn ${cls}`.trim(), attr: { "aria-label": label, title: label } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
    return b;
  }

  private toggle(key: "showList" | "showRail"): void {
    this.layout[key] = !this.layout[key];
    this.applyLayout();
    this.saveLayout();
  }

  /** Drag handle that resizes the column on its left; double-click hides that column. */
  private makeHandle(parent: HTMLElement, which: "list" | "rail"): void {
    const handle = parent.createDiv({
      cls: `ailm-handle ailm-handle-${which}`,
      attr: { role: "separator", "aria-orientation": "vertical", tabindex: "0", "aria-label": t(which === "list" ? "view.resizeList" : "view.resizeRail") },
    });
    const min = which === "list" ? 180 : 120;
    const max = which === "list" ? 600 : 420;
    const set = (w: number): void => {
      this.layout[which] = Math.round(Math.min(max, Math.max(min, w)));
      this.applyLayout();
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.layout[which];
      handle.setPointerCapture(e.pointerId);
      handle.addClass("is-dragging");
      // The width animation would lag behind the pointer while dragging.
      this.columnsEl.addClass("is-resizing");
      const move = (ev: PointerEvent): void => set(startW + ev.clientX - startX);
      const up = (): void => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        handle.removeClass("is-dragging");
        this.columnsEl.removeClass("is-resizing");
        this.saveLayout();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => this.toggle(which === "list" ? "showList" : "showRail"));
    handle.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      this.columnsEl.addClass("is-resizing");
      set(this.layout[which] + (e.key === "ArrowRight" ? 16 : -16));
      this.saveLayout();
    });
    handle.addEventListener("keyup", () => this.columnsEl.removeClass("is-resizing"));
  }

  private async openSelected(): Promise<void> {
    const file = this.selected ? this.app.vault.getFileByPath(this.selected) : null;
    if (file) await this.app.workspace.getLeaf("tab").openFile(file);
  }
}
