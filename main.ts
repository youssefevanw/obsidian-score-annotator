import { Plugin, WorkspaceLeaf } from "obsidian";
import { OverlayController } from "./src/overlay";

export default class ScoreAnnotatorPlugin extends Plugin {
  private controllers = new WeakMap<WorkspaceLeaf, OverlayController>();

  async onload() {
    this.addCommand({
      id: "toggle-annotation-mode",
      name: "Toggle annotation mode",
      callback: () => this.getActiveController()?.toggleActive(),
    });

    this.addCommand({
      id: "save-annotations",
      name: "Save annotations to PDF",
      callback: () => void this.getActiveController()?.save(),
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
  }

  private syncLeaves() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "pdf") return;
      const existing = this.controllers.get(leaf);
      if (existing) {
        existing.syncFile();
        return;
      }
      const controller = new OverlayController(this.app, leaf);
      this.controllers.set(leaf, controller);
      controller.attach();
    });
  }

  private getActiveController(): OverlayController | undefined {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf) return undefined;
    return this.controllers.get(leaf);
  }
}
