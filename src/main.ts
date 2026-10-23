// Entry point of the AI Log Manager plugin.
import * as os from "node:os";
import * as nodeFs from "node:fs/promises";
import { FileSystemAdapter, Notice, Plugin, setIcon } from "obsidian";
import { createNodeDisk } from "./adapters/node-disk";
import { collectLogSources } from "./adapters/log-sources";
import { createNodeGit } from "./adapters/node-git";
import { ObsidianVaultPort } from "./adapters/obsidian-vault";
import { CheckpointStore } from "./core/checkpoints";
import { DevService } from "./core/dev-service";
import { LogEngine } from "./core/engine";
import { HookHandler } from "./core/hook-handler";
import { DEFAULT_LOG_SETTINGS } from "./core/ports";
import type { LogSettings, SecureHttp } from "./core/ports";
import { ProjectCreator } from "./core/project-creator";
import type { TemplateNoteCreator } from "./core/project-creator";
import { ProjectTracker } from "./core/project-tracker";
import { RemoteSync } from "./core/remote";
import { SessionLocator } from "./core/session-locator";
import { isTopLevelTranscript, watchFolder } from "./core/watcher";
import type { FolderWatcher } from "./core/watcher";
import { EcosystemConnector } from "./ecosystem/connector";
import type { ConnectorStatus } from "./ecosystem/connector";
import { MissingEcosystemModal } from "./ecosystem/dependency-modal";
import { createSetupHandler, registerSetupHandler } from "./ecosystem/setup";
import { AI_ECOSYSTEM_API_VERSION } from "./ecosystem/types";
import hookScript from "./hook/ai-log-manager-hook.mjs";
import { hooksInstalled, mergeHooks } from "./hook/hook-installer";
import type { ClaudeSettings } from "./hook/hook-installer";
import { t } from "./i18n";
import { stripBom } from "./core/text-utils";
import { DEV_INSTRUCTIONS, buildDevTools } from "./tools/dev-tools";
import { MODULE_ID, MODULE_INSTRUCTIONS, buildRoutes, buildTools } from "./tools/log-module";
import { confirm } from "./ui/confirm-modal";
import { registerGraphBlock } from "./ui/graph-block";
import { LOGS_VIEW_TYPE, LogsView } from "./ui/logs-view";
import { AILogManagerSettingTab } from "./ui/settings-tab";
import type { SettingsHost } from "./ui/settings-tab";

function normalizeSettings(raw: unknown): LogSettings {
  const r = (typeof raw === "object" && raw !== null ? (raw as { settings?: Partial<LogSettings> }).settings : undefined) ?? {};
  return {
    ...DEFAULT_LOG_SETTINGS,
    ...r,
    mode: r.mode === "observe" ? "observe" : "active",
    trackedFolders: Array.isArray(r.trackedFolders) ? r.trackedFolders.filter((f): f is string => typeof f === "string") : [],
  };
}

/** The part of the Environment Keys service used for remote reads. */
interface SecretsRequestService {
  request?(req: { method: "GET"; url: string; headers?: Record<string, string> }, callerModuleId: string): Promise<{ status: number; body: string }>;
}

export default class AILogManagerPlugin extends Plugin implements SettingsHost {
  settings: LogSettings = { ...DEFAULT_LOG_SETTINGS };

  private store!: CheckpointStore;
  private engine!: LogEngine;
  private tracker!: ProjectTracker;
  private locator!: SessionLocator;
  private hookHandler!: HookHandler;
  private dev!: DevService;
  private gitWatchers: FolderWatcher[] = [];
  private unregisterSetupHandler: (() => void) | undefined;
  private connector!: EcosystemConnector;
  private settingTab: AILogManagerSettingTab | undefined;
  private statusBarEl: HTMLElement | undefined;
  private statusIconEl: HTMLElement | undefined;
  private statusTextEl: HTMLElement | undefined;
  private transcriptWatcher: FolderWatcher | undefined;
  private spoolWatcher: FolderWatcher | undefined;
  private hooksOk = false;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    const disk = createNodeDisk();
    const vault = new ObsidianVaultPort(this.app);
    this.locator = new SessionLocator(disk, () => this.claudeHome());
    this.tracker = new ProjectTracker(vault, disk, () => this.settings);
    this.store = await CheckpointStore.open(
      {
        load: async () => {
          const path = `${this.pluginDir()}/checkpoints.json`;
          return (await disk.exists(path)) ? (JSON.parse(await disk.readText(path)) as unknown) : undefined;
        },
        save: async (data) => {
          await nodeFs.mkdir(this.pluginDir(), { recursive: true });
          await nodeFs.writeFile(`${this.pluginDir()}/checkpoints.json`, JSON.stringify(data), "utf8");
        },
      },
      () => Date.now(),
    );
    this.engine = new LogEngine({
      disk,
      vault,
      locator: this.locator,
      tracker: this.tracker,
      store: this.store,
      settings: () => this.settings,
      log: (message, detail) => console.debug("[AI Log Manager]", message, detail),
    });
    const secureHttp: SecureHttp = async (req) => {
      const secrets = this.connector?.getApi()?.getService<SecretsRequestService>("secrets");
      if (!secrets?.request) throw new Error("Environment Keys is not available.");
      const res = await secrets.request({ method: req.method, url: req.url, headers: req.headers }, MODULE_ID);
      return { status: res.status, body: res.body };
    };
    const remote = new RemoteSync(secureHttp, () => ({ github: this.settings.githubSecret, bitbucket: this.settings.bitbucketSecret }));
    this.dev = new DevService(createNodeGit(), vault, this.store, () => this.settings, () => (this.settings.remoteEnabled ? remote : undefined));
    const creator = new ProjectCreator(vault, () => this.settings, () => this.templates());
    this.hookHandler = new HookHandler(
      this.engine,
      this.tracker,
      this.store,
      creator,
      {
        confirmNewProject: ({ cwd, name }) =>
          confirm(this.app, {
            title: t("project.new.title"),
            body: t("project.new.body", { cwd, name }),
            yes: t("project.new.yes"),
            no: t("project.new.no"),
            icon: "folder-git-2",
          }),
      },
      (name) => new Notice(t("project.created", { name })),
      () => this.dev,
      () => this.settings.devEnabled,
    );

    this.setupStatusBar();
    this.connector = new EcosystemConnector(this, {
      buildRegistration: () => {
        const deps = {
          engine: this.engine,
          locator: this.locator,
          tracker: this.tracker,
          store: this.store,
          hooks: this.hookHandler,
          dev: this.dev,
          settings: () => this.settings,
          runtime: () => ({ watching: this.transcriptWatcher !== undefined, hooksInstalled: this.hooksOk, connected: this.connector.isConnected() }),
        };
        return {
          id: MODULE_ID,
          name: this.manifest.name,
          version: this.manifest.version,
          apiVersion: AI_ECOSYSTEM_API_VERSION,
          tools: [...buildTools(deps), ...buildDevTools({ dev: this.dev, tracker: this.tracker })],
          routes: buildRoutes(deps),
          instructions: `${MODULE_INSTRUCTIONS} ${DEV_INSTRUCTIONS}`,
        };
      },
      onStatus: () => {
        this.updateStatusBar();
        this.settingTab?.refresh();
      },
      onMissing: () => new MissingEcosystemModal(this.app).open(),
      onIncompatible: (reason) => new Notice(reason),
      onConnected: (api) => {
        this.unregisterSetupHandler?.();
        this.syncToolIndex();
        this.unregisterSetupHandler = registerSetupHandler(
          api,
          createSetupHandler({
            getSettings: () => this.settings,
            saveSettings: () => this.saveSettings(),
            facts: async () => ({
              existingLogs: collectLogSources(this.app).length,
              projectsWithClone: (await this.tracker.projects()).filter((p) => p.clonePath).map((p) => p.name),
              hooksInstalled: await this.hooksInstalled(),
              claudeHomeFound: await disk.exists(`${this.claudeHome()}/projects`),
            }),
            folderExists: (path) => this.app.vault.getFolderByPath(path) !== null,
            installHooks: () => this.applyHooks(),
          }),
        );
      },
    });
    this.connector.start();

    this.registerView(LOGS_VIEW_TYPE, (leaf) => new LogsView(leaf, { dev: () => this.dev, tracker: () => this.tracker }));
    registerGraphBlock((lang, handler) => this.registerMarkdownCodeBlockProcessor(lang, handler), this.app, () => this.dev, () => this.tracker);
    this.addRibbonIcon("scroll-text", t("core.cmd.openView"), () => void this.openLogsView());
    this.addCommand({ id: "open-logs-view", name: t("core.cmd.openView"), callback: () => void this.openLogsView() });
    this.addCommand({ id: "reconcile-logs", name: t("core.cmd.syncAll"), callback: () => void this.reconcileNow() });
    this.addCommand({ id: "sync-dev-events", name: t("core.cmd.syncDev"), callback: () => void this.syncDev(true) });
    this.addCommand({ id: "install-hooks", name: t("core.cmd.installHooks"), callback: () => void this.installHooks() });

    this.settingTab = new AILogManagerSettingTab(this.app, this, this);
    this.addSettingTab(this.settingTab);

    this.app.workspace.onLayoutReady(() => void this.start());
  }

  onunload(): void {
    this.transcriptWatcher?.stop();
    this.spoolWatcher?.stop();
    for (const w of this.gitWatchers) w.stop();
    this.unregisterSetupHandler?.();
    this.connector?.stop();
    void this.store?.flush();
  }

  // ---- SettingsHost ---------------------------------------------------------

  async saveSettings(): Promise<void> {
    try {
      await this.saveData({ settings: this.settings });
      this.restartWatchers();
    } catch (err) {
      console.error("[AI Log Manager] Could not save settings", err);
    }
  }

  getConnectorStatus(): { status: ConnectorStatus; detail?: string } {
    return { status: this.connector.status, detail: this.connector.statusDetail };
  }

  async hooksInstalled(): Promise<boolean> {
    try {
      const settings = await this.readClaudeSettings();
      this.hooksOk = hooksInstalled(settings, this.hookScriptPath());
    } catch {
      this.hooksOk = false;
    }
    return this.hooksOk;
  }

  async installHooks(): Promise<void> {
    const ok = await confirm(this.app, {
      title: t("settings.hooks.install"),
      body: t("settings.hooks.installDesc"),
      yes: t("settings.hooks.installButton"),
      no: t("project.new.no"),
      icon: "webhook",
    });
    if (!ok) return;
    try {
      await this.applyHooks();
      new Notice(t("core.notice.hooksInstalled", { path: this.claudeSettingsPath() }));
    } catch (err) {
      new Notice(t("core.notice.hooksFailed", { reason: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Writes the hook script and registers it in the Claude Code settings (a backup is kept). */
  async applyHooks(): Promise<void> {
    await this.writeHookScript();
    const file = this.claudeSettingsPath();
    const settings = await this.readClaudeSettings();
    const merged = mergeHooks(settings, this.hookScriptPath());
    if (merged.changed) {
      try {
        await nodeFs.copyFile(file, `${file}.ai-log-manager.bak`);
      } catch {
        // No settings file yet: nothing to back up.
      }
      await nodeFs.mkdir(this.claudeHome(), { recursive: true });
      await nodeFs.writeFile(file, `${JSON.stringify(merged.settings, null, 2)}\n`, "utf8");
    }
    this.hooksOk = true;
  }

  async openLogsView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LOGS_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: LOGS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async reconcileNow(): Promise<void> {
    const results = await this.engine.syncAll({ force: true });
    new Notice(
      t("core.notice.syncDone", {
        created: results.filter((r) => r.status === "created").length,
        updated: results.filter((r) => r.status === "updated").length,
        entries: results.reduce((n, r) => n + r.added, 0),
      }),
    );
  }

  // ---- Internals ------------------------------------------------------------

  private async start(): Promise<void> {
    await this.writeHookScript();
    await this.hooksInstalled();
    this.startWatchers();
    // Decision D2: complete what was missed while Obsidian was closed.
    await this.drainSpool();
    const results = await this.engine.syncAll();
    if (results.some((r) => r.status === "created" || r.status === "updated")) {
      console.debug("[AI Log Manager] Reconciled on open", results.length);
    }
    await this.syncDev(false);
    await this.startGitWatchers();
    this.updateStatusBar();
  }

  private startWatchers(): void {
    this.stopWatchers();
    if (this.settings.watch) {
      this.transcriptWatcher = watchFolder(this.locator.projectsDir(), {
        recursive: true,
        debounceMs: () => this.settings.debounceSeconds * 1000,
        accept: isTopLevelTranscript,
        onChange: (path) => void this.engine.syncTranscript(path),
        onError: (err) => console.debug("[AI Log Manager] Transcript watcher", err),
      });
    }
    this.spoolWatcher = watchFolder(this.spoolDir(), {
      debounceMs: () => 200,
      accept: (name) => name.endsWith(".json"),
      onChange: () => void this.drainSpool(),
      onError: (err) => console.debug("[AI Log Manager] Spool watcher", err),
    });
  }

  /** Records what is new in the repositories of the projects (also what happened while Obsidian was closed). */
  async syncDev(manual: boolean): Promise<void> {
    if (!this.settings.devEnabled) return;
    this.tracker.invalidate();
    let created = 0;
    for (const project of await this.tracker.projects()) {
      if (!project.clonePath) continue;
      const res = await this.dev.sync(project, { remote: manual });
      created += res.created.length;
      for (const err of res.errors) console.debug("[AI Log Manager] dev sync", project.name, err);
    }
    if (manual) new Notice(t("core.notice.devDone", { created }));
  }

  /** Watches the reflogs of the project clones: a commit, a push or a new branch changes them. */
  private async startGitWatchers(): Promise<void> {
    for (const w of this.gitWatchers) w.stop();
    this.gitWatchers = [];
    if (!this.settings.devEnabled) return;
    for (const project of await this.tracker.projects()) {
      if (!project.clonePath) continue;
      this.gitWatchers.push(
        watchFolder(`${project.clonePath}/.git/logs`, {
          recursive: true,
          debounceMs: () => 3000,
          onChange: () => void this.dev.sync(project),
          onError: (err) => console.debug("[AI Log Manager] Git watcher", project.name, err),
        }),
      );
    }
  }

  private stopWatchers(): void {
    this.transcriptWatcher?.stop();
    this.spoolWatcher?.stop();
    this.transcriptWatcher = undefined;
    this.spoolWatcher = undefined;
  }

  private restartWatchers(): void {
    this.startWatchers();
    this.tracker.invalidate();
    void this.startGitWatchers();
    this.updateStatusBar();
  }

  /** Reads the events the hook dropped (also those from while Obsidian was closed). */
  private async drainSpool(): Promise<void> {
    const dir = this.spoolDir();
    let names: string[];
    try {
      names = (await nodeFs.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const file = `${dir}/${name}`;
      try {
        const event = HookHandler.parse(JSON.parse(await nodeFs.readFile(file, "utf8")));
        await nodeFs.rm(file, { force: true });
        if (event) await this.hookHandler.handle(event);
      } catch (err) {
        console.debug("[AI Log Manager] Spool event failed", name, err);
        await nodeFs.rm(file, { force: true }).catch(() => undefined);
      }
    }
  }

  private templates(): TemplateNoteCreator | undefined {
    try {
      return this.connector?.getApi()?.getService<TemplateNoteCreator>("templates");
    } catch {
      return undefined;
    }
  }

  private claudeHome(): string {
    return (this.settings.claudeHome.trim() || `${os.homedir()}/.claude`).replace(/\\/g, "/");
  }

  private claudeSettingsPath(): string {
    return `${this.claudeHome()}/settings.json`;
  }

  private async readClaudeSettings(): Promise<ClaudeSettings> {
    try {
      return JSON.parse(stripBom(await nodeFs.readFile(this.claudeSettingsPath(), "utf8"))) as ClaudeSettings;
    } catch {
      return {};
    }
  }

  private pluginDir(): string {
    const adapter = this.app.vault.adapter;
    const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${base}/${dir}`.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  }

  private spoolDir(): string {
    return `${this.pluginDir()}/spool`;
  }

  private hookScriptPath(): string {
    return `${this.pluginDir()}/hook/ai-log-manager-hook.mjs`;
  }

  private async writeHookScript(): Promise<void> {
    const path = this.hookScriptPath();
    try {
      const current = await nodeFs.readFile(path, "utf8").catch(() => "");
      if (current === hookScript) return;
      await nodeFs.mkdir(`${this.pluginDir()}/hook`, { recursive: true });
      await nodeFs.writeFile(path, hookScript, "utf8");
    } catch (err) {
      console.debug("[AI Log Manager] Could not write the hook script", err);
    }
  }

  private setupStatusBar(): void {
    const el = this.addStatusBarItem();
    el.addClass("ailm-status-bar");
    el.setAttribute("aria-label", t("core.status.connected"));
    this.statusIconEl = el.createSpan({ cls: "ailm-status-bar-icon" });
    this.statusTextEl = el.createSpan({ cls: "ailm-status-bar-text" });
    this.statusBarEl = el;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl || !this.statusIconEl || !this.statusTextEl) return;
    const status = this.connector?.status ?? "missing";
    this.statusBarEl.removeClass("ailm-state-connected", "ailm-state-waiting", "ailm-state-error");
    const map: Record<ConnectorStatus, { icon: string; cls: string }> = {
      connected: { icon: "scroll-text", cls: "ailm-state-connected" },
      waiting: { icon: "clock", cls: "ailm-state-waiting" },
      disconnected: { icon: "plug-zap", cls: "ailm-state-waiting" },
      incompatible: { icon: "x-circle", cls: "ailm-state-error" },
      missing: { icon: "alert-triangle", cls: "ailm-state-error" },
    };
    this.statusBarEl.addClass(map[status].cls);
    setIcon(this.statusIconEl, map[status].icon);
    const suffix = this.settings.mode === "observe" ? " (observe)" : "";
    this.statusTextEl.setText(`${t(`core.status.${status}`)}${status === "connected" ? suffix : ""}`);
  }
  private syncToolIndex(): void {
    const api = this.connector?.getApi();
    if (!api?.toolIndex) return;
    const deps = {
      engine: this.engine,
      locator: this.locator,
      tracker: this.tracker,
      store: this.store,
      hooks: this.hookHandler,
      dev: this.dev,
      settings: () => this.settings,
      runtime: () => ({ watching: this.transcriptWatcher !== undefined, hooksInstalled: this.hooksOk, connected: this.connector.isConnected() }),
    };
    const tools = [...buildTools(deps), ...buildDevTools({ dev: this.dev, tracker: this.tracker })];
    const entries = tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      categoria: t.categoria,
      tags: t.tags,
      resumo: t.resumo,
      efeito: t.efeito,
      exposicao: t.exposicao,
      aprovacao: t.aprovacao,
    }));
    api.toolIndex.sync(MODULE_ID, entries).catch((err: unknown) => {
      console.error("[AI Log Manager] Could not sync the tool index", err);
    });
  }
}