import { Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { OverlayController } from "./src/overlay";
import { NewPaperCanvasModal } from "./src/paper-modal";
import { PaperOptions, generatePaperPdf } from "./src/paper-generator";
import { PersistedSettings } from "./src/types";

// Coalesces rapid-fire edits (e.g. dragging the OS color picker) into one
// disk write.
const SETTINGS_SAVE_DEBOUNCE_MS = 500;

export default class ScoreAnnotatorPlugin extends Plugin {
  private controllers = new WeakMap<WorkspaceLeaf, OverlayController>();
  private settings: PersistedSettings = {};
  private settingsSaveTimer: number | null = null;

  async onload() {
    this.settings = (await this.loadData()) ?? {};

    this.addCommand({
      id: "toggle-draw-mode",
      name: "Toggle draw/pan mode",
      callback: () => this.getActiveController()?.toggleDrawMode(),
    });

    this.addCommand({
      id: "save-annotations",
      name: "Save annotations to PDF",
      callback: () => void this.getActiveController()?.save(),
    });

    this.addCommand({
      id: "new-paper-canvas",
      name: "New paper canvas",
      callback: () => this.openNewCanvasModal(),
    });

    this.addCommand({
      id: "paste-image",
      name: "Paste image onto page",
      callback: () => void this.getActiveController()?.pasteImageFromClipboard(),
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.syncLeaves()),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncLeaves()),
    );
    // Catches close→reopen where the same leaf is reused for a different
    // PDF, or even the same PDF: layout-change/active-leaf-change don't
    // always fire in that case, but file-open does.
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.syncLeaves()),
    );

    this.app.workspace.onLayoutReady(() => this.syncLeaves());
  }

  onunload() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const controller = this.controllers.get(leaf);
      if (controller) {
        controller.destroy();
        this.controllers.delete(leaf);
      }
    });
    // Flush a pending debounced write rather than losing the last edit.
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
      void this.saveData(this.settings);
    }
  }

  private syncLeaves() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf") return;
      const existing = this.controllers.get(leaf);
      if (existing) {
        existing.syncFile();
        return;
      }
      const controller = new OverlayController(this.app, leaf, {
        getSettings: () => this.settings,
        saveSettings: (patch) => this.saveSettings(patch),
      });
      this.controllers.set(leaf, controller);
      controller.attach();
    });
  }

  private saveSettings(patch: Partial<PersistedSettings>) {
    Object.assign(this.settings, patch);
    if (this.settingsSaveTimer !== null) window.clearTimeout(this.settingsSaveTimer);
    this.settingsSaveTimer = window.setTimeout(() => {
      this.settingsSaveTimer = null;
      void this.saveData(this.settings);
    }, SETTINGS_SAVE_DEBOUNCE_MS);
  }

  private getActiveController(): OverlayController | undefined {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) return undefined;
    return this.controllers.get(leaf);
  }

  private openNewCanvasModal(): void {
    new NewPaperCanvasModal(this.app, async (opts, fileName) => {
      try {
        const bytes = await generatePaperPdf(opts);
        const path = await this.uniquePdfPath(fileName);
        const file = await this.app.vault.createBinary(
          path,
          bytes.slice().buffer as ArrayBuffer,
        );
        const leaf = this.app.workspace.getLeaf(true);
        if (file instanceof TFile) {
          await leaf.openFile(file);
        }
      } catch (err) {
        console.error("ScoreAnnotator: new paper canvas failed:", err);
        new Notice("Failed to create paper canvas");
      }
    }).open();
  }

  private async uniquePdfPath(rawName: string): Promise<string> {
    const baseName = rawName.replace(/\.pdf$/i, "");
    const candidate = normalizePath(`${baseName}.pdf`);
    if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    for (let n = 2; n < 1000; n++) {
      const c = normalizePath(`${baseName} (${n}).pdf`);
      if (!this.app.vault.getAbstractFileByPath(c)) return c;
    }
    return candidate;
  }
}
