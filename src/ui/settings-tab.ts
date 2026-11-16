// Declarative settings tab (Obsidian 1.13+) for the AI Log Manager plugin.
import { Notice, PluginSettingTab, setIcon } from "obsidian";
import type { App, Plugin, Setting, SettingDefinitionItem } from "obsidian";
import type { ConnectorStatus } from "../ecosystem/connector";
import { installEcosystem } from "../ecosystem/dependency-modal";
import { t } from "../i18n";
import type { LogSettings } from "../core/ports";

export interface SettingsHost {
  settings: LogSettings;
  saveSettings(): Promise<void>;
  getConnectorStatus(): { status: ConnectorStatus; detail?: string };
  hooksInstalled(): Promise<boolean>;
  nodeAvailable?(): Promise<boolean>;
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
      if (this.containerEl.isShown()) this.update();
    } catch (err) {
      console.debug("[AI Log Manager] Could not refresh the settings tab", err);
    }
  }

  getControlValue(key: string): unknown {
    const s = this.host.settings;
    switch (key) {
      case "mode":
        return s.mode;
      case "watch":
        return s.watch;
      case "debounceSeconds":
        return s.debounceSeconds;
      case "trackedFolders":
        return s.trackedFolders.join("\n");
      case "projectsRoot":
        return s.projectsRoot;
      case "projectLogsFolder":
        return s.projectLogsFolder;
      default:
        return undefined;
    }
  }

  setControlValue(key: string, value: unknown): void {
    const s = this.host.settings;
    switch (key) {
      case "mode":
        s.mode = value === "observe" ? "observe" : "active";
        break;
      case "watch":
        s.watch = Boolean(value);
        break;
      case "debounceSeconds": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 1 && n <= 120) s.debounceSeconds = n;
        break;
      }
      case "trackedFolders":
        s.trackedFolders = (typeof value === "string" ? value : "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "");
        break;
      case "projectsRoot":
        s.projectsRoot = (typeof value === "string" ? value : "").trim().replace(/\/+$/, "") || "Projetos";
        break;
      case "projectLogsFolder":
        s.projectLogsFolder = (typeof value === "string" ? value : "").trim().replace(/^\/+|\/+$/g, "") || "Logs";
        break;
      default:
        return;
    }
    void this.host.saveSettings();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: t("settings.ecosystem.heading"),
        items: [
          {
            name: t("settings.ecosystem.heading"),
            render: (row: Setting) => {
              this.renderEcosystemRow(row);
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.engine.heading"),
        items: [
          {
            name: t("settings.engine.mode"),
            desc: t("settings.engine.modeDesc"),
            control: {
              type: "dropdown",
              key: "mode",
              options: {
                active: t("settings.engine.modeActive"),
                observe: t("settings.engine.modeObserve"),
              },
            },
          },
          {
            name: t("settings.engine.watch"),
            desc: t("settings.engine.watchDesc"),
            control: {
              type: "toggle",
              key: "watch",
            },
          },
          {
            name: t("settings.engine.debounce"),
            desc: t("settings.engine.debounceDesc"),
            control: {
              type: "number",
              key: "debounceSeconds",
              min: 1,
              max: 120,
              step: 1,
            },
          },
          {
            name: t("settings.engine.folders"),
            desc: t("settings.engine.foldersDesc"),
            render: (row: Setting) => {
              row.setName(t("settings.engine.folders")).setDesc(t("settings.engine.foldersDesc"));
              row.addTextArea((ta) => {
                ta.setValue(this.host.settings.trackedFolders.join("\n")).onChange((v) => {
                  this.setControlValue("trackedFolders", v);
                });
                ta.inputEl.rows = 3;
                ta.inputEl.addClass("ailm-mono");
              });
            },
          },
          {
            name: t("settings.engine.reconcile"),
            desc: t("settings.engine.reconcileDesc"),
            render: (row: Setting) => {
              row
                .setName(t("settings.engine.reconcile"))
                .setDesc(t("settings.engine.reconcileDesc"))
                .addButton((btn) =>
                  btn
                    .setButtonText(t("settings.engine.reconcileButton"))
                    .setIcon("refresh-cw")
                    .onClick(() => {
                      btn.setDisabled(true);
                      void this.host.reconcileNow().finally(() => {
                        btn.setDisabled(false);
                      });
                    }),
                );
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.project.heading"),
        items: [
          {
            name: t("settings.project.root"),
            desc: t("settings.project.rootDesc"),
            control: {
              type: "text",
              key: "projectsRoot",
            },
          },
          {
            name: t("settings.project.logsFolder"),
            desc: t("settings.project.logsFolderDesc"),
            control: {
              type: "text",
              key: "projectLogsFolder",
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.hooks.heading"),
        items: [
          {
            name: t("settings.hooks.install"),
            desc: t("settings.hooks.installDesc"),
            render: (row: Setting) => {
              this.renderHooksRow(row);
            },
          },
        ],
      },
    ];
  }

  private renderEcosystemRow(row: Setting): void {
    const { status, detail } = this.host.getConnectorStatus();
    const meta = STATUS_ICON[status];
    row.setName(t(`core.status.${status === "connected" ? "connected" : status}`)).setDesc(detail ?? "");
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
                this.update();
              })
              .catch(() => {
                new Notice(t("dependency.failed"));
                btn.setDisabled(false);
              });
          }),
      );
    }
  }

  private renderHooksRow(row: Setting): void {
    row.setName(t("settings.hooks.install")).setDesc(t("settings.hooks.installDesc"));
    row.addButton((btn) =>
      btn
        .setButtonText(t("settings.hooks.installButton"))
        .setIcon("webhook")
        .onClick(() => {
          btn.setDisabled(true);
          void this.host
            .installHooks()
            .then(() => {
              this.update();
            })
            .finally(() => {
              btn.setDisabled(false);
            });
        }),
    );
    void Promise.all([
      this.host.hooksInstalled(),
      this.host.nodeAvailable ? this.host.nodeAvailable() : Promise.resolve(true),
    ]).then(([installed, nodeOk]) => {
      const stateText = t("settings.hooks.state", {
        state: installed ? t("settings.hooks.installed") : t("settings.hooks.notInstalled"),
      });
      const warn = nodeOk ? "" : ` ${t("settings.hooks.nodeMissing")}`;
      row.setDesc(`${t("settings.hooks.installDesc")} ${stateText}${warn}`);
    });
  }
}
