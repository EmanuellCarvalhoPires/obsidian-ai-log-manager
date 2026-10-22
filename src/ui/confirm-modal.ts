// A yes/no question. Resolves false when the dialog is closed any other way.
import { Modal, Setting, setIcon } from "obsidian";
import type { App } from "obsidian";

export interface ConfirmOptions {
  title: string;
  body: string;
  yes: string;
  no: string;
  icon?: string;
}

export class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly options: ConfirmOptions,
    private readonly done: (answer: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.addClass("ailm-modal");
    const icon = titleEl.createSpan({ cls: "ailm-modal-icon" });
    setIcon(icon, this.options.icon ?? "help-circle");
    titleEl.appendText(this.options.title);
    contentEl.createEl("p", { text: this.options.body });
    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText(this.options.yes).setCta().onClick(() => this.finish(true)))
      .addButton((btn) => btn.setButtonText(this.options.no).onClick(() => this.finish(false)));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.done(false);
    this.answered = true;
  }

  private finish(answer: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.done(answer);
    this.close();
  }
}

export function confirm(app: App, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, options, resolve).open());
}
