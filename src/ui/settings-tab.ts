// Settings tab (imperative, Obsidian-standard) for the AI Log Manager plugin.
import { Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { ConnectorStatus } from "../ecosystem/connector";
import { installEcosystem } from "../ecosystem/dependency-modal";
import { t } from "../i18n";
import type { LogSettings } from "../core/ports";

export interface SettingsHost {
  settings: LogSettings;
  saveSettings(): Promise<void>;
  getConnectorStatus(): { status: ConnectorStatus; detail?: string };
  hooksInstalled(): Promise<boolean>;
  installHooks(): Promise<void>;
  reconcileNow(): Promise<void>;
}

const STATUS_ICON: Record<ConnectorStatus, { icon: string; state: string }> = {
  connected: { icon: "check-circle-2", state: "connected" },
  waiting: { icon: "clock", state: "waiting" },
  disconnected: { icon: "plug-zap", state: "waiting" },
  incompatible: { icon: "x-circle", state: "error" },
  missing: { icon: "alert-triangle", state: "error" },
};

export class AILogManagerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    super(app, plugin);
    this.icon = "scroll-text";
  }

  refresh(): void {
    try {
      if (this.containerEl.isShown()) this.display();
    } catch (err) {
      console.debug("[AI Log Manager] Could not refresh the settings tab", err);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderEcosystem(containerEl);
    this.renderEngine(containerEl);
    this.renderProjects(containerEl);
    void this.renderHooks(containerEl);
  }

  private renderEcosystem(el: HTMLElement): void {
    new Setting(el).setHeading().setName(t("settings.ecosystem.heading"));
    const { status, detail } = this.host.getConnectorStatus();
    const meta = STATUS_ICON[status];
    const row = new Setting(el).setName(t(`core.status.${status === "connected" ? "connected" : status}`)).setDesc(detail ?? "");
    const icon = createSpan({ cls: `ailm-status-icon ailm-status-${meta.state}` });
    setIcon(icon, meta.icon);
    row.nameEl.prepend(icon);
    if (status === "missing") {
      row.addButton((btn) =>
        btn
          .setButtonText(t("dependency.install"))
          .setIcon("download")
          .setCta()
          .onClick(() => {
            btn.setDisabled(true);
            void installEcosystem(this.app)
              .then(() => {
                new Notice(t("dependency.installed"));
                this.display();
              })
              .catch(() => {
                new Notice(t("dependency.failed"));
                btn.setDisabled(false);
              });
          }),
      );
    }
  }

  private renderEngine(el: HTMLElement): void {
    new Setting(el).setHeading().setName(t("settings.engine.heading"));
    const s = this.host.settings;

    new Setting(el)
      .setName(t("settings.engine.mode"))
      .setDesc(t("settings.engine.modeDesc"))
      .addDropdown((dd) =>
        dd
          .addOption("active", t("settings.engine.modeActive"))
          .addOption("observe", t("settings.engine.modeObserve"))
          .setValue(s.mode)
          .onChange((v) => {
            s.mode = v === "observe" ? "observe" : "active";
            void this.host.saveSettings();
          }),
      );

    new Setting(el)
      .setName(t("settings.engine.watch"))
      .setDesc(t("settings.engine.watchDesc"))
      .addToggle((tg) =>
        tg.setValue(s.watch).onChange((v) => {
          s.watch = v;
          void this.host.saveSettings();
        }),
      );

    new Setting(el)
      .setName(t("settings.engine.debounce"))
      .setDesc(t("settings.engine.debounceDesc"))
      .addText((tx) =>
        tx.setValue(String(s.debounceSeconds)).onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1 && n <= 120) {
            s.debounceSeconds = n;
            void this.host.saveSettings();
          }
        }),
      );

    new Setting(el)
      .setName(t("settings.engine.folders"))
      .setDesc(t("settings.engine.foldersDesc"))
      .addTextArea((ta) => {
        ta.setValue(s.trackedFolders.join("\n")).onChange((v) => {
          s.trackedFolders = v
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "");
          void this.host.saveSettings();
        });
        ta.inputEl.rows = 3;
        ta.inputEl.addClass("ailm-mono");
      });

    new Setting(el)
      .setName(t("settings.engine.reconcile"))
      .setDesc(t("settings.engine.reconcileDesc"))
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.engine.reconcileButton"))
          .setIcon("refresh-cw")
          .onClick(() => {
            btn.setDisabled(true);
            void this.host.reconcileNow().finally(() => btn.setDisabled(false));
          }),
      );
  }

  private renderProjects(el: HTMLElement): void {
    new Setting(el).setHeading().setName(t("settings.project.heading"));
    const s = this.host.settings;
    new Setting(el)
      .setName(t("settings.project.root"))
      .setDesc(t("settings.project.rootDesc"))
      .addText((tx) =>
        tx.setValue(s.projectsRoot).onChange((v) => {
          s.projectsRoot = v.trim().replace(/\/+$/, "") || "Projetos";
          void this.host.saveSettings();
        }),
      );
    new Setting(el)
      .setName(t("settings.project.logsFolder"))
      .setDesc(t("settings.project.logsFolderDesc"))
      .addText((tx) =>
        tx.setValue(s.projectLogsFolder).onChange((v) => {
          s.projectLogsFolder = v.trim().replace(/^\/+|\/+$/g, "") || "Logs";
          void this.host.saveSettings();
        }),
      );
  }

  private async renderHooks(el: HTMLElement): Promise<void> {
    const installed = await this.host.hooksInstalled();
    new Setting(el).setHeading().setName(t("settings.hooks.heading"));
    new Setting(el)
      .setName(t("settings.hooks.install"))
      .setDesc(`${t("settings.hooks.installDesc")} ${t("settings.hooks.state", { state: installed ? t("settings.hooks.installed") : t("settings.hooks.notInstalled") })}`)
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.hooks.installButton"))
          .setIcon("webhook")
          .onClick(() => {
            btn.setDisabled(true);
            void this.host
              .installHooks()
              .then(() => this.display())
              .finally(() => btn.setDisabled(false));
          }),
      );
  }
}
