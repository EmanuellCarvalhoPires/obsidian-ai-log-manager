// Right-click menu of a log in the list: the same options Obsidian shows for a note in the file
// explorer, plus "Open JSONL file" (the transcript, or the Antigravity conversation file).
import { FuzzySuggestModal, Menu, Modal, Notice, Platform, Setting, TFile } from "obsidian";
import type { App, TFolder, WorkspaceLeaf } from "obsidian";
import { revealInFolder } from "../adapters/reveal";
import type { SourceFile } from "../core/log-source-file";
import { t } from "../i18n";
import { confirm } from "./confirm-modal";

export interface LogMenuHost {
  app: App;
  /** Finds the transcript or conversation file of the log (undefined when there is none). */
  resolveSource(path: string): Promise<SourceFile | undefined>;
}

/** Name for a copy of a file in its folder: "Note 1.md", "Note 2.md"... */
export function copyPathFor(exists: (path: string) => boolean, folder: string, basename: string, extension: string): string {
  const dir = folder && folder !== "/" ? `${folder}/` : "";
  for (let n = 1; ; n++) {
    const candidate = `${dir}${basename} ${n}.${extension}`;
    if (!exists(candidate)) return candidate;
  }
}

class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private readonly folders: TFolder[],
    private readonly choose: (folder: TFolder) => void,
  ) {
    super(app);
    this.setPlaceholder(t("menu.moveTo"));
  }
  getItems(): TFolder[] {
    return this.folders;
  }
  getItemText(folder: TFolder): string {
    return folder.path === "/" ? "/" : folder.path;
  }
  onChooseItem(folder: TFolder): void {
    this.choose(folder);
  }
}

class RenameModal extends Modal {
  constructor(
    app: App,
    private readonly current: string,
    private readonly done: (name: string) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t("menu.rename"));
    let value = this.current;
    const submit = (): void => {
      const name = value.trim();
      if (name && name !== this.current) this.done(name);
      this.close();
    };
    new Setting(this.contentEl).addText((text) => {
      text.setValue(this.current).onChange((v) => (value = v));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      window.setTimeout(() => {
        text.inputEl.focus();
        text.inputEl.select();
      }, 0);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText(t("menu.rename")).setCta().onClick(submit));
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

export function showLogMenu(host: LogMenuHost, path: string, event: MouseEvent): void {
  const { app } = host;
  const file = app.vault.getFileByPath(path);
  if (!file) return;
  const menu = new Menu();
  const open = (type: "tab" | "split" | "window"): void => {
    const leaf: WorkspaceLeaf = type === "split" ? app.workspace.getLeaf("split", "vertical") : app.workspace.getLeaf(type);
    void leaf.openFile(file);
  };

  menu.addItem((i) => i.setTitle(t("menu.openTab")).setIcon("file-plus").onClick(() => open("tab")));
  menu.addItem((i) => i.setTitle(t("menu.openRight")).setIcon("separator-vertical").onClick(() => open("split")));
  menu.addItem((i) => i.setTitle(t("menu.openWindow")).setIcon("picture-in-picture-2").onClick(() => open("window")));
  menu.addSeparator();
  menu.addItem((i) => i.setTitle(t("menu.copy")).setIcon("copy").onClick(() => void makeCopy(app, file)));
  menu.addItem((i) =>
    i.setTitle(t("menu.move")).setIcon("folder-tree").onClick(() => {
      new FolderPicker(app, app.vault.getAllFolders(true), (folder) => {
        const target = folder.path === "/" ? file.name : `${folder.path}/${file.name}`;
        if (target !== file.path) void app.fileManager.renameFile(file, target);
      }).open();
    }),
  );
  menu.addSeparator();
  // Bookmarks, merge, Git, version history and other plugins add their items to the same event.
  app.workspace.trigger("file-menu", menu, file, "ailm-logs-view");
  menu.addSeparator();
  menu.addItem((i) => i.setTitle(t("menu.copyVaultPath")).setIcon("clipboard-copy").onClick(() => void navigator.clipboard.writeText(file.path)));
  menu.addItem((i) =>
    i.setTitle(t("menu.copySystemPath")).setIcon("clipboard-list").onClick(() => {
      const base = (app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? "";
      void navigator.clipboard.writeText(`${base}/${file.path}`);
    }),
  );
  menu.addSeparator();
  if (Platform.isDesktopApp) {
    menu.addItem((i) => i.setTitle(t("menu.openDefault")).setIcon("external-link").onClick(() => (app as unknown as { openWithDefaultApp(p: string): void }).openWithDefaultApp(file.path)));
    menu.addItem((i) => i.setTitle(t("menu.showInFolder")).setIcon("folder-open").onClick(() => (app as unknown as { showInFolder(p: string): void }).showInFolder(file.path)));
    menu.addItem((i) => i.setTitle(t("menu.openJsonl")).setIcon("braces").onClick(() => void openSourceFile(host, path)));
  }
  menu.addSeparator();
  menu.addItem((i) =>
    i.setTitle(t("menu.rename")).setIcon("pencil").onClick(() => {
      new RenameModal(app, file.basename, (name) => {
        const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
        void app.fileManager.renameFile(file, `${dir}${name}.${file.extension}`);
      }).open();
    }),
  );
  menu.addItem((i) =>
    i
      .setTitle(t("menu.delete"))
      .setIcon("trash-2")
      .setWarning(true)
      .onClick(() => {
        void confirm(app, { title: t("menu.delete"), body: t("menu.deleteBody", { name: file.basename }), yes: t("menu.delete"), no: t("project.new.no"), icon: "trash-2" }).then((ok) => {
          if (ok) void app.fileManager.trashFile(file);
        });
      }),
  );
  menu.showAtMouseEvent(event);
}

async function makeCopy(app: App, file: TFile): Promise<void> {
  const target = copyPathFor((p) => app.vault.getAbstractFileByPath(p) !== null, file.parent?.path ?? "", file.basename, file.extension);
  await app.vault.copy(file, target);
}

/** Opens the folder of the transcript (or Antigravity conversation) of a log, with the file selected. */
export async function openSourceFile(host: LogMenuHost, path: string): Promise<void> {
  const source = await host.resolveSource(path);
  if (!source) {
    new Notice(t("menu.jsonlMissing"));
    return;
  }
  if (!revealInFolder(source.path)) new Notice(t("menu.jsonlFailed", { path: source.path }));
}
