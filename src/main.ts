// Entry point of the AI Log Manager plugin.
import * as os from "node:os";
import { registerAgentLogos } from "./ui-agent-logos";
import * as nodeFs from "node:fs/promises";
import { FileSystemAdapter, Notice, Plugin, TFile, setIcon } from "obsidian";
import { createCheckpointStorage } from "./adapters/checkpoint-storage";
import { createNodeDisk } from "./adapters/node-disk";
import { createNodeSqlite } from "./adapters/node-sqlite";
import { AntigravitySync } from "./core/antigravity-sync";
import { collectLogSources } from "./adapters/log-sources";
import { ObsidianVaultPort } from "./adapters/obsidian-vault";
import { CheckpointStore } from "./core/checkpoints";
import { buildIndex } from "./core/log-index";
import type { LogRecord } from "./core/log-index";
import { resolveSourceFile } from "./core/log-source-file";
import type { SourceFile } from "./core/log-source-file";
import { LogEngine } from "./core/engine";
import { HookHandler } from "./core/hook-handler";
import { DEFAULT_LOG_SETTINGS } from "./core/ports";
import type { DiskPort, LogSettings } from "./core/ports";
import { ProjectCreator } from "./core/project-creator";
import type { TemplateNoteCreator } from "./core/project-creator";
import { ProjectTracker } from "./core/project-tracker";
import { SessionLocator } from "./core/session-locator";
import { isTopLevelTranscript, watchFolder } from "./core/watcher";
import type { FolderWatcher } from "./core/watcher";
import { EcosystemConnector } from "./ecosystem/connector";
import type { ConnectorStatus } from "./ecosystem/connector";
import { MissingEcosystemModal } from "./ecosystem/dependency-modal";
import { createSetupHandler, registerSetupHandler } from "./ecosystem/setup";
import { AI_ECOSYSTEM_API_VERSION, SECRETS_SERVICE } from "./ecosystem/types";
import type { SecretVaultService } from "./ecosystem/types";
import hookScript from "./hook/ai-log-manager-hook.mjs";
import {
  SpoolDrainer,
  applyClaudeHooksSafe,
  checkNodeInPath,
  hooksInstalled,
  readClaudeSettingsSafe,
} from "./hook/hook-installer";
import { t } from "./i18n";
import { MODULE_ID, MODULE_INSTRUCTIONS, buildRoutes, buildTools } from "./tools/log-module";
import { confirm } from "./ui/confirm-modal";
import { LOGS_VIEW_TYPE, LogsView } from "./ui/logs-view";
import { AILogManagerSettingTab } from "./ui/settings-tab";
import type { SettingsHost } from "./ui/settings-tab";

/** Settings keys of versions that recorded development events (now AI Git Tools); dropped when the settings load. */
const LEGACY_SETTING_KEYS = ["devEnabled", "eventsFolder", "graphLimit", "remoteEnabled", "githubSecret", "bitbucketSecret"];

function normalizeSettings(raw: unknown): LogSettings {
  const r = (typeof raw === "object" && raw !== null ? (raw as { settings?: Partial<LogSettings> }).settings : undefined) ?? {};
  const settings: LogSettings = {
    ...DEFAULT_LOG_SETTINGS,
    ...r,
    mode: r.mode === "observe" ? "observe" : "active",
    trackedFolders: Array.isArray(r.trackedFolders) ? r.trackedFolders.filter((f): f is string => typeof f === "string") : [],
  };
  for (const key of LEGACY_SETTING_KEYS) delete (settings as unknown as Record<string, unknown>)[key];
  return settings;
}

export default class AILogManagerPlugin extends Plugin implements SettingsHost {
  settings: LogSettings = { ...DEFAULT_LOG_SETTINGS };

  private store!: CheckpointStore;
  private engine!: LogEngine;
  private tracker!: ProjectTracker;
  private locator!: SessionLocator;
  private hookHandler!: HookHandler;
  private spoolDrainer!: SpoolDrainer;
  private unregisterSetupHandler: (() => void) | undefined;
  private connector!: EcosystemConnector;
  private settingTab: AILogManagerSettingTab | undefined;
  private statusBarEl: HTMLElement | undefined;
  private statusIconEl: HTMLElement | undefined;
  private statusTextEl: HTMLElement | undefined;
  private transcriptWatcher: FolderWatcher | undefined;
  private antigravity!: AntigravitySync;
  private antigravityWatchers: FolderWatcher[] = [];
  private spoolWatcher: FolderWatcher | undefined;
  private hooksOk = false;

  async onload(): Promise<void> {
    registerAgentLogos();
    this.settings = normalizeSettings(await this.loadData());
    const disk = createNodeDisk();
    const vault = new ObsidianVaultPort(this.app);
    this.locator = new SessionLocator(disk, () => this.claudeHome());
    this.tracker = new ProjectTracker(vault, disk, () => this.settings);
    this.store = await CheckpointStore.open(
      createCheckpointStorage(this.pluginDir(), {
        onCorrupt: ({ reason, backup }) => {
          console.error("[AI Log Manager] Could not read checkpoints.json", reason, backup);
          new Notice(t("core.notice.checkpointsCorrupt", { backup: backup ?? "-" }), 15000);
        },
      }),
      () => Date.now(),
    );
    // Gemini (Antigravity) conversations are read from their SQLite file, not from a JSONL transcript.
    this.antigravity = new AntigravitySync({
      db: createNodeSqlite(),
      disk,
      vault,
      tracker: this.tracker,
      store: this.store,
      settings: () => this.settings,
      appFolders: () => this.antigravityAppFolders(),
      redact: (text) => this.redactWithSecretsService(text),
      log: (message, detail) => console.debug("[AI Log Manager]", message, detail),
    });
    this.engine = new LogEngine({
      antigravity: this.antigravity,
      disk,
      vault,
      locator: this.locator,
      tracker: this.tracker,
      store: this.store,
      settings: () => this.settings,
      redact: (text) => this.redactWithSecretsService(text),
      log: (message, detail) => console.debug("[AI Log Manager]", message, detail),
    });
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
    );
    this.spoolDrainer = new SpoolDrainer(
      () => this.spoolDir(),
      (event) => this.hookHandler.handle(event),
      () => Date.now(),
      (name, err) => console.debug("[AI Log Manager] Spool event failed", name, err),
    );

    // LM-18: mark session as ignored when the user deletes its log note.
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.engine.onNoteDeleted(file.path);
      }),
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
          settings: () => this.settings,
          runtime: () => ({
            watching: this.transcriptWatcher?.isActive() === true,
            hooksInstalled: this.hooksOk,
            connected: this.connector.isConnected(),
          }),
        };
        return {
          id: MODULE_ID,
          name: this.manifest.name,
          version: this.manifest.version,
          apiVersion: AI_ECOSYSTEM_API_VERSION,
          tools: buildTools(deps),
          routes: buildRoutes(deps),
          instructions: MODULE_INSTRUCTIONS,
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

    this.registerView(
      LOGS_VIEW_TYPE,
      (leaf) =>
        new LogsView(leaf, {
          resolveSource: (path, record) => this.resolveSource(path, record, disk),
          readText: (path) => disk.readText(path),
        }),
    );
    this.addRibbonIcon("scroll-text", t("core.cmd.openView"), () => void this.openLogsView());
    this.addCommand({ id: "open-logs-view", name: t("core.cmd.openView"), callback: () => void this.openLogsView() });
    this.addCommand({ id: "reconcile-logs", name: t("core.cmd.syncAll"), callback: () => void this.reconcileNow() });
    this.addCommand({ id: "install-hooks", name: t("core.cmd.installHooks"), callback: () => void this.installHooks() });

    this.settingTab = new AILogManagerSettingTab(this.app, this, this);
    this.addSettingTab(this.settingTab);

    this.app.workspace.onLayoutReady(() => void this.start());
  }

  onunload(): void {
    this.transcriptWatcher?.stop();
    for (const w of this.antigravityWatchers) w.stop();
    this.spoolWatcher?.stop();
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
      const { settings } = await readClaudeSettingsSafe(this.claudeSettingsPath());
      this.hooksOk = hooksInstalled(settings, this.hookScriptPath());
    } catch {
      this.hooksOk = false;
    }
    return this.hooksOk;
  }

  async nodeAvailable(): Promise<boolean> {
    return checkNodeInPath();
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

  /** Writes the hook script and registers it in the Claude Code settings safely (LM-01). */
  async applyHooks(): Promise<void> {
    await this.writeHookScript();
    await applyClaudeHooksSafe(this.claudeSettingsPath(), this.hookScriptPath());
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

  /** Transcript (.jsonl) or Antigravity conversation (.db) a log was made from. */
  private async resolveSource(path: string, record: LogRecord | undefined, disk: DiskPort): Promise<SourceFile | undefined> {
    const rec = record ?? buildIndex(collectLogSources(this.app)).find((r) => r.path === path);
    if (!rec) return undefined;
    return resolveSourceFile(rec, {
      exists: (p) => disk.exists(p),
      fromCheckpoint: (sessao) => this.store.all().find((c) => c.hostSessionId === sessao && c.caminhoTranscript)?.caminhoTranscript,
      findTranscript: (id) => this.locator.transcriptPath(id),
      conversationFolders: () => this.antigravityFolders(),
    });
  }

  /** `~/.gemini/<app>` of each Antigravity app; the conversations are in `conversations/` inside. */
  private antigravityAppFolders(): string[] {
    const home = os.homedir().replace(/\\/g, "/");
    return ["antigravity", "antigravity-cli", "antigravity-ide"].map((d) => `${home}/.gemini/${d}`);
  }

  private antigravityFolders(): string[] {
    return this.antigravityAppFolders().map((app) => `${app}/conversations`);
  }

  /** Writes `jsonl` / `jsonl_caminho` in the Antigravity logs that do not have them (the files are `<sessao>.db`). */
  private async backfillAntigravityProps(disk: DiskPort): Promise<void> {
    for (const rec of buildIndex(collectLogSources(this.app))) {
      if (rec.agent !== "gemini" || rec.transcript || !rec.sessao) continue;
      const source = await resolveSourceFile(rec, {
        exists: (p) => disk.exists(p),
        fromCheckpoint: () => undefined,
        findTranscript: () => Promise.resolve(undefined),
        conversationFolders: () => this.antigravityFolders(),
      });
      const file = this.app.vault.getFileByPath(rec.path);
      if (!source || !file) continue;
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        fm.jsonl = source.path.split("/").pop();
        fm.jsonl_caminho = source.path;
      });
    }
  }

  private async start(): Promise<void> {
    await this.writeHookScript();
    await this.hooksInstalled();
    this.startWatchers();
    void this.backfillAntigravityProps(createNodeDisk()).catch((err: unknown) => console.debug("[AI Log Manager] Antigravity properties", err));
    // Decision D2: complete what was missed while Obsidian was closed.
    await this.drainSpool();
    const results = await this.engine.syncAll();
    if (results.some((r) => r.status === "created" || r.status === "updated")) {
      console.debug("[AI Log Manager] Reconciled on open", results.length);
    }
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
      // Gemini: a new step is written to `<id>.db-wal` first, so both files count as a change of `<id>.db`.
      this.antigravityWatchers = this.antigravityFolders().map((folder) =>
        watchFolder(folder, {
          debounceMs: () => this.settings.debounceSeconds * 1000,
          accept: (name) => name.endsWith(".db") || name.endsWith(".db-wal"),
          onChange: (path) => void this.antigravity.syncFile(path.replace(/-wal$/, "")),
          onError: (err) => console.debug("[AI Log Manager] Antigravity watcher", err),
          retryMs: 0,
        }),
      );
    }
    this.spoolWatcher = watchFolder(this.spoolDir(), {
      debounceMs: () => 200,
      accept: (name) => name.endsWith(".json"),
      onChange: () => void this.drainSpool(),
      onError: (err) => console.debug("[AI Log Manager] Spool watcher", err),
    });
  }

  private stopWatchers(): void {
    this.transcriptWatcher?.stop();
    this.spoolWatcher?.stop();
    for (const w of this.antigravityWatchers) w.stop();
    this.antigravityWatchers = [];
    this.transcriptWatcher = undefined;
    this.spoolWatcher = undefined;
  }

  private restartWatchers(): void {
    this.startWatchers();
    this.tracker.invalidate();
    this.updateStatusBar();
  }

  /** Reads the events the hook dropped (serialized and age-checked via SpoolDrainer, LM-13). */
  private async drainSpool(): Promise<void> {
    await this.spoolDrainer.drain();
  }

  private redactWithSecretsService(text: string): string {
    try {
      const secrets = this.connector?.getApi()?.getService<SecretVaultService>(SECRETS_SERVICE);
      return secrets ? secrets.redact(text) : text;
    } catch {
      return text;
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
      settings: () => this.settings,
      runtime: () => ({
        watching: this.transcriptWatcher?.isActive() === true,
        hooksInstalled: this.hooksOk,
        connected: this.connector.isConnected(),
      }),
    };
    const tools = buildTools(deps);
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
