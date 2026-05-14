import { App, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { PageStrokes, Point, Stroke, Tool } from "./types";
import { Toolbar } from "./toolbar";
import { writeStrokesIntoPdf } from "./pdf-writer";
import { readStrokesFromPdf } from "./pdf-reader";
import { deleteSidecar, readSidecar, writeSidecar } from "./sidecar";

interface PageBinding {
  pageEl: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  pageIndex: number;
  resizeObserver: ResizeObserver;
  currentStroke: Stroke | null;
}

const AUTOSAVE_DEBOUNCE_MS = 500;
const SIDECAR_RETRY_LIMIT = 30;
const SIDECAR_RETRY_DELAY_MS = 100;
const SCROLL_BUFFER_PX = 1000; // bind canvases this far above/below viewport

export class OverlayController {
  private active = false;
  private tool: Tool = "pen";
  private color = "#e63946";
  private width = 2;
  private opacity = 1;

  // Permanent stroke store — survives binding/unbinding
  private allStrokes = new Map<number, Stroke[]>();

  // Only live for visible/near-visible pages
  private bindings = new Map<HTMLElement, PageBinding>();

  private scrollContainer: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private toolbar: Toolbar | null = null;
  private initialLoadStarted = false;
  // Path of the file whose strokes are currently loaded into allStrokes.
  // Drives reload-on-file-change: if the leaf navigates to a different PDF
  // (or the same PDF after a close/reopen), we re-read from disk.
  private loadedFilePath: string | null = null;
  // True once the PDF on disk holds any of our InkAnnotations. Lets erase-all
  // round-trip: saving with no in-memory strokes still strips the baked set.
  private hasBakedStrokes = false;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private scrollHandler: (() => void) | null = null;
  private autosaveTimer: number | null = null;
  private saving = false;
  private syncPagesTimer: number | null = null;
  private scrollSyncTimer: number | null = null;

  constructor(private app: App, private leaf: WorkspaceLeaf) {}

  attach() {
    const root = this.leaf.view.containerEl;
    this.toolbar = new Toolbar(root, {
      isActive: () => this.active,
      onToggle: () => this.toggleActive(),
      getTool: () => this.tool,
      setTool: (t) => (this.tool = t),
      getColor: () => this.color,
      setColor: (c) => (this.color = c),
      getWidth: () => this.width,
      setWidth: (w) => (this.width = w),
      getOpacity: () => this.opacity,
      setOpacity: (o) => (this.opacity = o),
      onSave: () => void this.save(),
    });

    // Find scroll container
    this.scrollContainer =
      root.querySelector<HTMLElement>(".pdf-viewer-container") ?? root;

    // Watch scroll to update visible canvases
    this.scrollHandler = () => this.debouncedScrollSync();
    this.scrollContainer.addEventListener("scroll", this.scrollHandler, { passive: true });

    // MutationObserver: watch for page elements appearing
    this.observer = new MutationObserver(() => this.debouncedSyncPages());
    this.observer.observe(root, { childList: true, subtree: true });

    this.keydownHandler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      if (!this.active && !this.hasUnsavedStrokes()) return;
      e.preventDefault();
      e.stopPropagation();
      void this.save();
    };
    root.addEventListener("keydown", this.keydownHandler, true);

    void this.loadInitialStateWhenReady();

    // Initial sync after layout settles
    window.setTimeout(() => this.syncVisiblePages(), 5000);
  }

  destroy() {
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (this.syncPagesTimer !== null) {
      window.clearTimeout(this.syncPagesTimer);
      this.syncPagesTimer = null;
    }
    if (this.scrollSyncTimer !== null) {
      window.clearTimeout(this.scrollSyncTimer);
      this.scrollSyncTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    if (this.scrollHandler && this.scrollContainer) {
      this.scrollContainer.removeEventListener("scroll", this.scrollHandler);
      this.scrollHandler = null;
    }
    this.toolbar?.destroy();
    this.toolbar = null;
    if (this.keydownHandler) {
      this.leaf.view.containerEl.removeEventListener(
        "keydown",
        this.keydownHandler,
        true,
      );
      this.keydownHandler = null;
    }
    for (const binding of this.bindings.values()) {
      binding.resizeObserver.disconnect();
      binding.canvas.remove();
    }
    this.bindings.clear();
  }

  toggleActive() {
    this.active = !this.active;
    for (const b of this.bindings.values()) {
      b.canvas.classList.toggle("score-annotator-active", this.active);
    }
    this.toolbar?.refresh();
  }

  async save() {
    if (this.saving) return;
    const file = this.getFile();
    if (!file) {
      new Notice("ScoreAnnotator: no PDF in this view");
      return;
    }
    const pages = this.collectPageStrokes();
    if (pages.length === 0 && !this.hasBakedStrokes) {
      new Notice("Nothing to save");
      return;
    }
    this.saving = true;
    try {
      const original = await this.app.vault.readBinary(file);
      const bakPath = file.path + ".bak";
      const existingBak = this.app.vault.getAbstractFileByPath(bakPath);
      if (!existingBak) {
        await this.app.vault.createBinary(bakPath, original);
      }
      const newBytes = await writeStrokesIntoPdf(original, pages);
      await this.app.vault.modifyBinary(
        file,
        newBytes.slice().buffer as ArrayBuffer,
      );
      await deleteSidecar(this.app, file);
      this.hasBakedStrokes = pages.length > 0;
      new Notice("Annotations saved");
    } catch (err) {
      console.error("ScoreAnnotator save failed:", err);
      new Notice("Save failed — see console");
    } finally {
      this.saving = false;
    }
  }

  private collectPageStrokes(): PageStrokes[] {
    const out: PageStrokes[] = [];
    for (const [pageIndex, strokes] of this.allStrokes) {
      if (strokes.length === 0) continue;
      out.push({ pageIndex, strokes: strokes.slice() });
    }
    return out;
  }

  private hasUnsavedStrokes(): boolean {
    for (const strokes of this.allStrokes.values()) {
      if (strokes.length > 0) return true;
    }
    return false;
  }

  private getFile(): TFile | null {
    const f = (this.leaf.view as unknown as { file?: unknown }).file;
    return f instanceof TFile ? f : null;
  }

  private loadInitialStateWhenReady(attempt = 0): void {
    if (this.initialLoadStarted) return;
    const file = this.getFile();
    if (!file) {
      if (attempt < SIDECAR_RETRY_LIMIT) {
        window.setTimeout(
          () => this.loadInitialStateWhenReady(attempt + 1),
          SIDECAR_RETRY_DELAY_MS,
        );
      }
      return;
    }
    this.initialLoadStarted = true;
    void this.applyInitialState(file);
  }

  // Called by the plugin on workspace events. If the leaf has switched to a
  // different PDF (or re-opened the same one after a close), drop the current
  // in-memory strokes and re-read from disk.
  syncFile(): void {
    const file = this.getFile();
    if (!file) return;
    if (this.loadedFilePath === file.path) return;
    for (const binding of this.bindings.values()) {
      binding.canvas
        .getContext("2d")
        ?.clearRect(0, 0, binding.canvas.width, binding.canvas.height);
    }
    this.allStrokes.clear();
    this.hasBakedStrokes = false;
    this.initialLoadStarted = true;
    void this.applyInitialState(file);
  }

  private async applyInitialState(file: TFile) {
    this.loadedFilePath = file.path;
    const touched = new Set<number>();

    try {
      const bytes = await this.app.vault.readBinary(file);
      const baked = await readStrokesFromPdf(bytes);
      const total = baked.reduce((n, p) => n + p.strokes.length, 0);
      console.info(
        `ScoreAnnotator: loaded ${total} baked stroke(s) across ${baked.length} page(s) from ${file.path}`,
      );
      for (const page of baked) {
        this.allStrokes.set(page.pageIndex, page.strokes.slice());
        touched.add(page.pageIndex);
      }
      this.hasBakedStrokes = total > 0;
    } catch (err) {
      console.warn("ScoreAnnotator: failed to read baked annotations:", err);
    }

    // Sidecar wins when present: it represents the full unsaved state,
    // which already includes any previously-baked strokes the user kept.
    const sidecar = await readSidecar(this.app, file);
    if (sidecar) {
      for (const page of sidecar) {
        this.allStrokes.set(page.pageIndex, page.strokes.slice());
        touched.add(page.pageIndex);
      }
    }

    for (const pageIndex of touched) {
      const binding = this.bindingForPageIndex(pageIndex);
      if (binding) this.redraw(binding);
    }
  }

  private bindingForPageIndex(pageIndex: number): PageBinding | undefined {
    for (const b of this.bindings.values()) {
      if (b.pageIndex === pageIndex) return b;
    }
    return undefined;
  }

  private debouncedSyncPages() {
    if (this.syncPagesTimer !== null) window.clearTimeout(this.syncPagesTimer);
    this.syncPagesTimer = window.setTimeout(() => {
      this.syncPagesTimer = null;
      this.syncVisiblePages();
    }, 200);
  }

  private debouncedScrollSync() {
    if (this.scrollSyncTimer !== null) window.clearTimeout(this.scrollSyncTimer);
    this.scrollSyncTimer = window.setTimeout(() => {
      this.scrollSyncTimer = null;
      this.syncVisiblePages();
    }, 50);
  }

  // Core logic: bind canvases only to pages near the viewport
  private syncVisiblePages() {
    if (!this.scrollContainer) return;

    const containerRect = this.scrollContainer.getBoundingClientRect();
    const viewTop = containerRect.top - SCROLL_BUFFER_PX;
    const viewBottom = containerRect.bottom + SCROLL_BUFFER_PX;

    const root = this.leaf.view.containerEl;
    const pageEls = Array.from(root.querySelectorAll<HTMLElement>(".page"));
    const shouldBind = new Set<HTMLElement>();

    for (const pageEl of pageEls) {
      const rect = pageEl.getBoundingClientRect();
      if (rect.bottom >= viewTop && rect.top <= viewBottom) {
        shouldBind.add(pageEl);
      }
    }

    // Bind pages now in range
    for (const pageEl of shouldBind) {
      if (!this.bindings.has(pageEl)) {
        const attr = pageEl.getAttribute("data-page-number");
        const pageIndex = attr ? parseInt(attr, 10) - 1 : 0;
        this.bindPage(pageEl, pageIndex);
      }
    }

    // Unbind pages that scrolled out of range
    for (const [pageEl, binding] of this.bindings) {
      if (!shouldBind.has(pageEl)) {
        this.unbindPage(pageEl, binding);
      }
    }
  }

  private bindPage(pageEl: HTMLElement, pageIndex: number) {
    if (this.bindings.has(pageEl)) return;

    if (getComputedStyle(pageEl).position === "static") {
      pageEl.style.position = "relative";
    }
    const canvas = document.createElement("canvas");
    canvas.className = "score-annotator-overlay";
    if (this.active) canvas.classList.add("score-annotator-active");
    pageEl.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const binding: PageBinding = {
      pageEl,
      canvas,
      ctx,
      pageIndex,
      resizeObserver: new ResizeObserver(() => this.resizeCanvas(binding)),
      currentStroke: null,
    };
    binding.resizeObserver.observe(pageEl);
    this.resizeCanvas(binding);

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e, binding));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e, binding));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e, binding));
    canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e, binding));

    this.bindings.set(pageEl, binding);
    this.redraw(binding);
  }

  private unbindPage(pageEl: HTMLElement, binding: PageBinding) {
    binding.resizeObserver.disconnect();
    binding.canvas.remove();
    this.bindings.delete(pageEl);
  }

  private resizeCanvas(b: PageBinding) {
    const rect = b.pageEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    b.canvas.width = Math.round(rect.width * dpr);
    b.canvas.height = Math.round(rect.height * dpr);
    b.canvas.style.width = `${rect.width}px`;
    b.canvas.style.height = `${rect.height}px`;
    b.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw(b);
  }

  private pointFromEvent(e: PointerEvent, b: PageBinding): Point {
    const rect = b.canvas.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    return {
      x: (e.clientX - rect.left) / w,
      y: (e.clientY - rect.top) / h,
    };
  }

  private onPointerDown(e: PointerEvent, b: PageBinding) {
    if (!this.active) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (b.canvas.width === 0 || b.canvas.height === 0) this.resizeCanvas(b);
    b.canvas.setPointerCapture(e.pointerId);
    const p = this.pointFromEvent(e, b);
    if (this.tool === "eraser") {
      this.eraseAt(p, b);
      b.currentStroke = {
        tool: "eraser",
        color: "",
        width: this.width,
        opacity: 1,
        points: [p],
      };
    } else {
      b.currentStroke = {
        tool: "pen",
        color: this.color,
        width: this.width,
        opacity: this.opacity,
        points: [p],
      };
    }
    this.redraw(b);
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent, b: PageBinding) {
    if (!b.currentStroke) return;
    const p = this.pointFromEvent(e, b);
    if (b.currentStroke.tool === "eraser") {
      this.eraseAt(p, b);
    } else {
      b.currentStroke.points.push(p);
    }
    this.redraw(b);
    e.preventDefault();
  }

  private onPointerUp(e: PointerEvent, b: PageBinding) {
    if (!b.currentStroke) return;
    const wasPen = b.currentStroke.tool === "pen";
    if (wasPen && b.currentStroke.points.length > 0) {
      const strokes = this.allStrokes.get(b.pageIndex) ?? [];
      strokes.push(b.currentStroke);
      this.allStrokes.set(b.pageIndex, strokes);
    }
    b.currentStroke = null;
    if (b.canvas.hasPointerCapture(e.pointerId)) {
      b.canvas.releasePointerCapture(e.pointerId);
    }
    this.redraw(b);
    this.scheduleAutosave();
  }

  private scheduleAutosave() {
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      void this.flushAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private async flushAutosave() {
    const file = this.getFile();
    if (!file) return;
    const pages = this.collectPageStrokes();
    try {
      if (pages.length === 0) {
        await deleteSidecar(this.app, file);
      } else {
        await writeSidecar(this.app, file, pages);
      }
    } catch (err) {
      console.warn("ScoreAnnotator autosave failed:", err);
    }
  }

  private eraseAt(p: Point, b: PageBinding) {
    const rect = b.canvas.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    const radiusCss = Math.max(8, this.width * 2);
    const r2 = radiusCss * radiusCss;
    const strokes = this.allStrokes.get(b.pageIndex) ?? [];
    const filtered = strokes.filter((s) => {
      for (const sp of s.points) {
        const dx = (sp.x - p.x) * w;
        const dy = (sp.y - p.y) * h;
        if (dx * dx + dy * dy <= r2) return false;
      }
      return true;
    });
    this.allStrokes.set(b.pageIndex, filtered);
  }

  private redraw(b: PageBinding) {
    const rect = b.pageEl.getBoundingClientRect();
    b.ctx.clearRect(0, 0, rect.width, rect.height);
    const strokes = this.allStrokes.get(b.pageIndex) ?? [];
    for (const stroke of strokes) {
      this.paintStroke(b.ctx, stroke, rect.width, rect.height);
    }
    if (b.currentStroke && b.currentStroke.tool === "pen") {
      this.paintStroke(b.ctx, b.currentStroke, rect.width, rect.height);
    }
  }

  private paintStroke(
    ctx: CanvasRenderingContext2D,
    stroke: Stroke,
    w: number,
    h: number,
  ) {
    if (stroke.points.length === 0) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke.width;
    ctx.globalAlpha = stroke.opacity;
    ctx.strokeStyle = stroke.color || "#000";
    ctx.beginPath();
    const [first, ...rest] = stroke.points;
    ctx.moveTo(first.x * w, first.y * h);
    for (const p of rest) ctx.lineTo(p.x * w, p.y * h);
    ctx.stroke();
    ctx.restore();
  }
}