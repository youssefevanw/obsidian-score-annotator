import { App, Modal, Notice, Setting } from "obsidian";
import {
  DEFAULT_STAVES_PER_PAGE,
  PaperOptions,
  PaperTemplate,
} from "./paper-generator";

const TEMPLATE_LABELS: Record<PaperTemplate, string> = {
  staff: "Staff (music)",
  blank: "Blank",
  "dot-grid": "Dot grid",
  graph: "Graph paper",
};

export class NewPaperCanvasModal extends Modal {
  private template: PaperTemplate = "staff";
  private stavesPerPage = DEFAULT_STAVES_PER_PAGE;
  private fileName = "Untitled Staff Paper";
  private stavesSetting: Setting | null = null;

  constructor(
    app: App,
    private onSubmit: (opts: PaperOptions, fileName: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "New paper canvas" });

    new Setting(contentEl).setName("Template").addDropdown((d) => {
      for (const key of Object.keys(TEMPLATE_LABELS) as PaperTemplate[]) {
        d.addOption(key, TEMPLATE_LABELS[key]);
      }
      d.setValue(this.template).onChange((v) => {
        this.template = v as PaperTemplate;
        this.updateStavesVisibility();
      });
    });

    this.stavesSetting = new Setting(contentEl)
      .setName("Staves per page")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.max = "24";
        t.setValue(String(this.stavesPerPage)).onChange((v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) this.stavesPerPage = n;
        });
      });
    this.updateStavesVisibility();

    new Setting(contentEl).setName("File name").addText((t) => {
      t.setValue(this.fileName).onChange((v) => (this.fileName = v));
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Create")
          .setCta()
          .onClick(() => this.submit()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updateStavesVisibility(): void {
    if (!this.stavesSetting) return;
    this.stavesSetting.settingEl.style.display =
      this.template === "staff" ? "" : "none";
  }

  private submit(): void {
    const name = this.fileName.trim();
    if (!name) {
      new Notice("File name required");
      return;
    }
    const opts: PaperOptions = { template: this.template };
    if (this.template === "staff") opts.stavesPerPage = this.stavesPerPage;
    this.onSubmit(opts, name);
    this.close();
  }
}
