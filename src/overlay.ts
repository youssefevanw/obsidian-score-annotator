import { App, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { PDFDocument } from "pdf-lib";
import { PageStrokes, Point, Stroke, Tool } from "./types";
import { Toolbar } from "./toolbar";
import { writeStrokesIntoPdf } from "./pdf-writer";
import { readStrokesFromPdf } from "./pdf-reader";
import { deleteSidecar, readSidecar, writeSidecar } from "./sidecar";
import {
  PaperTemplate,
  addTemplatePage,
  parsePaperSubject,
} from "./paper-generator";
import { History } from "./history";
import { decimateStroke, paintHighlighterStroke, paintPenStroke, strokeKind } from "./ink";
import { ERASER_RADII, HIGHLIGHTER_WIDTHS, PEN_WIDTHS } from "./presets";

const DEFAULT_SWATCH_COLORS: readonly string[] = [
  "#e63946",
  "#2d6a4f",
  "#1d3557",
  "#f4a261",
  "#000000",
  "#7C3AED",
];

// Q W E R T, in preset order — index i always maps to presets[i] for
// whichever tool is active (toolbar.ts's width-dot titles use the same
// labels so the on-screen hint matches).
const SIZE_KEY_CODES: readonly string[] = ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT"];

interface PageBinding {
  pageEl: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  pageIndex: number;
  resizeObserver: ResizeObserver;
  inkObserver: MutationObserver;
  currentStroke: Stroke | null;
  // Pre-gesture strokes touched by the eraser this gesture (restored on undo).
  eraseRemoved: Set<Stroke>;
  // Fragments created by this gesture that are still alive in allStrokes
  // (i.e. not themselves erased further within the same gesture).
  eraseAdded: Set<Stroke>;
  anyBakedErased: boolean;     // whether any baked stroke was erased in this gesture
}

const AUTOSAVE_DEBOUNCE_MS = 500;
const SIDECAR_RETRY_LIMIT = 30;
const SIDECAR_RETRY_DELAY_MS = 100;
const SCROLL_BUFFER_PX = 1000; // bind canvases this far above/below viewport
// RDP simplification tolerance applied to a stroke's centerline at gesture
// end, in CSS px at the page's current on-screen size (see decimateStroke).
const STROKE_DECIMATE_TOLERANCE_PX = 0.2;

export class OverlayController {
  // Pan/Draw mode. Only gates mouse/touch — pen always draws, and the
  // eraser override (hardware eraser tip / hold-X) works in both modes.
  private drawMode = false;
  private tool: Tool = "pen";
  private colors: string[] = DEFAULT_SWATCH_COLORS.slice();
  private activeColorIndex = 0;
  private penWidth = 2;
  private penOpacity = 1;
  private highlighterWidth = 12;
  private highlighterOpacity = 0.5;
  private eraserRadius = 16;
  // Temporary eraser override while the hold-key is held. Never mutates
  // `tool` — gestures started while true just run the eraser path.
  private eraserKeyHeld = false;
  // Non-null only when the open PDF is one we generated. Drives the
  // visibility of the "Add Page" button and remembers the staff count so
  // appended pages match the original layout.
  private paperTemplate: PaperTemplate | null = null;
  private paperStavesPerPage: number | undefined = undefined;

  // Permanent stroke store — survives binding/unbinding
  private allStrokes = new Map<number, Stroke[]>();
  // Strokes that are already baked into the PDF on disk. The overlay does
  // NOT paint these — PDF.js renders them from /AP /N into the page canvas,
  // and overlay-on-top produces visible double-strikes (Obsidian's PDF.js
  // and our canvas land at slightly different sub-pixel positions). Tracked
  // by identity via a WeakSet so erasing/replacing a stroke drops it from
  // the set automatically.
  private bakedStrokes = new WeakSet<Stroke>();
  private bakedRewriteTimer: number | null = null;

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
  private penStrokeActive = false;
  private history = new History();
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private eraserKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private eraserKeyupHandler: ((e: KeyboardEvent) => void) | null = null;
  private eraserKeyBlurHandler: (() => void) | null = null;
  private scrollHandler: (() => void) | null = null;
  private autosaveTimer: number | null = null;
  private saving = false;
  private syncPagesTimer: number | null = null;
  private scrollSyncTimer: number | null = null;
  private toolbarHasAddPage = false;

  constructor(private app: App, private leaf: WorkspaceLeaf) {}

  private buildToolbar(root: HTMLElement, withAddPage: boolean): void {
    this.toolbar?.destroy();
    this.toolbarHasAddPage = withAddPage;
    this.toolbar = new Toolbar(root, {
      isDrawMode: () => this.drawMode,
      onToggleDrawMode: () => this.toggleDrawMode(),
      getTool: () => this.tool,
      setTool: (t) => (this.tool = t),
      getColors: () => this.colors,
      setColor: (i, c) => {
        if (i >= 0 && i < this.colors.length) this.colors[i] = c;
      },
      getActiveColorIndex: () => this.activeColorIndex,
      setActiveColorIndex: (i) => {
        if (i >= 0 && i < this.colors.length) this.activeColorIndex = i;
      },
      getPenWidth: () => this.penWidth,
      setPenWidth: (w) => (this.penWidth = w),
      getHighlighterWidth: () => this.highlighterWidth,
      setHighlighterWidth: (w) => (this.highlighterWidth = w),
      getHighlighterOpacity: () => this.highlighterOpacity,
      setHighlighterOpacity: (o) => (this.highlighterOpacity = o),
      getEraserRadius: () => this.eraserRadius,
      setEraserRadius: (r) => (this.eraserRadius = r),
      isEraserOverride: () => this.eraserKeyHeld,
      onSave: () => void this.save(),
      onAddPage: withAddPage ? () => void this.addPage() : undefined,
    });
  }

  attach() {
    const root = this.leaf.view.containerEl;
    this.buildToolbar(root, false);

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
      const meta = e.metaKey || e.ctrlKey;
      if (meta) {
        const key = e.key.toLowerCase();
        if (key === "s") {
          if (!this.drawMode && !this.hasUnsavedStrokes()) return;
          e.preventDefault();
          e.stopPropagation();
          void this.save();
        } else if (key === "z" && !e.shiftKey) {
          if (!this.history.canUndo()) return;
          e.preventDefault();
          e.stopPropagation();
          this.applyUndo();
        } else if (key === "z" && e.shiftKey) {
          if (!this.history.canRedo()) return;
          e.preventDefault();
          e.stopPropagation();
          this.applyRedo();
        }
        return;
      }

      // Single-key tool/color/size shortcuts. Shift is fine (matched via
      // e.code so it's Shift-invariant); any other modifier, or focus in a
      // text input, and we leave the key alone.
      if (e.altKey) return;
      if (this.isTextInputFocused()) return;
      if (e.repeat) return;

      const colorMatch = /^Digit([1-6])$/.exec(e.code);
      if (colorMatch) {
        const idx = Number(colorMatch[1]) - 1;
        if (idx < this.colors.length) {
          this.activeColorIndex = idx;
          this.toolbar?.refresh();
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      const sizeIdx = SIZE_KEY_CODES.indexOf(e.code);
      if (sizeIdx !== -1) {
        const presets =
          this.tool === "eraser"
            ? ERASER_RADII
            : this.tool === "highlighter"
              ? HIGHLIGHTER_WIDTHS
              : PEN_WIDTHS;
        if (sizeIdx < presets.length) {
          const w = presets[sizeIdx];
          if (this.tool === "eraser") this.eraserRadius = w;
          else if (this.tool === "highlighter") this.highlighterWidth = w;
          else this.penWidth = w;
          this.toolbar?.refresh();
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (e.code === "KeyB") {
        this.tool = "pen";
        this.toolbar?.refresh();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.code === "KeyH") {
        this.tool = "highlighter";
        this.toolbar?.refresh();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };
    root.addEventListener("keydown", this.keydownHandler, true);

    // Hold-key eraser override (default "x" — "e" is taken by the size-3
    // shortcut above). Decided per-gesture at pointerdown — holding/
    // releasing never touches `tool` and never switches mid-stroke.
    this.eraserKeydownHandler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code !== "KeyX") return;
      if (this.isTextInputFocused()) return;
      this.eraserKeyHeld = true;
      this.toolbar?.refresh();
    };
    this.eraserKeyupHandler = (e: KeyboardEvent) => {
      if (e.code !== "KeyX") return;
      this.eraserKeyHeld = false;
      this.toolbar?.refresh();
    };
    // Defensive reset: if focus leaves the window while the key is held
    // (alt-tab, etc.), the keyup event may never arrive.
    this.eraserKeyBlurHandler = () => {
      if (!this.eraserKeyHeld) return;
      this.eraserKeyHeld = false;
      this.toolbar?.refresh();
    };
    root.addEventListener("keydown", this.eraserKeydownHandler);
    root.addEventListener("keyup", this.eraserKeyupHandler);
    window.addEventListener("blur", this.eraserKeyBlurHandler);

    void this.loadInitialStateWhenReady();

    // Bind whatever pages are already in the DOM right now. Without this, a
    // PDF that PDF.js rendered before our MutationObserver attached (warm
    // cache, second-open, etc.) would have no canvas bound — the toolbar
    // would show "Annotating" but pointer events go to the text layer.
    // Retry on a schedule because pages render asynchronously across a few
    // hundred ms on a cold open.
    this.syncVisiblePages();
    for (const ms of [100, 300, 800, 2000, 5000]) {
      window.setTimeout(() => this.syncVisiblePages(), ms);
    }
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
    if (this.bakedRewriteTimer !== null) {
      window.clearTimeout(this.bakedRewriteTimer);
      this.bakedRewriteTimer = null;
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
    if (this.eraserKeydownHandler) {
      this.leaf.view.containerEl.removeEventListener(
        "keydown",
        this.eraserKeydownHandler,
      );
      this.eraserKeydownHandler = null;
    }
    if (this.eraserKeyupHandler) {
      this.leaf.view.containerEl.removeEventListener(
        "keyup",
        this.eraserKeyupHandler,
      );
      this.eraserKeyupHandler = null;
    }
    if (this.eraserKeyBlurHandler) {
      window.removeEventListener("blur", this.eraserKeyBlurHandler);
      this.eraserKeyBlurHandler = null;
    }
    this.eraserKeyHeld = false;
    for (const binding of this.bindings.values()) {
      binding.resizeObserver.disconnect();
      binding.canvas.remove();
    }
    this.bindings.clear();
  }

  toggleDrawMode() {
    this.drawMode = !this.drawMode;
    for (const b of this.bindings.values()) {
      b.canvas.classList.toggle("score-annotator-draw-mode", this.drawMode);
    }
    this.toolbar?.refresh();
  }

  async save(successNotice = "Annotations saved") {
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
      // Pre-mark the strokes we're about to bake BEFORE writing. Once
      // modifyBinary returns, Obsidian fires a file-change event and
      // PDF.js can repaint the page canvas with these strokes baked from
      // /AP /N — at that point our overlay must already know to skip
      // them. Marking after the write opens a window where overlay +
      // canvas paint the same strokes, producing intermittent doubling.
      for (const pageStrokes of pages) {
        for (const s of pageStrokes.strokes) this.bakedStrokes.add(s);
      }
      await this.app.vault.modifyBinary(
        file,
        newBytes.slice().buffer as ArrayBuffer,
      );
      // Clear the overlay synchronously, before any further awaits let
      // PDF.js react to the file change. New bindings created in the
      // 200ms debounce window after this will also see the correct
      // bakedStrokes state.
      for (const b of this.bindings.values()) this.redraw(b);
      await deleteSidecar(this.app, file);
      this.hasBakedStrokes = pages.length > 0;
      new Notice(successNotice);
    } catch (err) {
      console.error("ScoreAnnotator save failed:", err);
      new Notice("Save failed — see console");
    } finally {
      this.saving = false;
    }
  }

  async addPage(): Promise<void> {
    if (this.saving) return;
    const file = this.getFile();
    if (!file || !this.paperTemplate) return;
    this.saving = true;
    try {
      const bytes = await this.app.vault.readBinary(file);
      const pdfDoc = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        throwOnInvalidObject: false,
      });
      addTemplatePage(pdfDoc, {
        template: this.paperTemplate,
        stavesPerPage: this.paperStavesPerPage,
      });
      const newBytes = await pdfDoc.save();
      await this.app.vault.modifyBinary(
        file,
        newBytes.slice().buffer as ArrayBuffer,
      );
      new Notice("Page added");
      // Force PDF.js to re-read so the new page appears. The leaf is
      // already on this file; openFile re-runs the viewer's load step.
      await this.leaf.openFile(file);
    } catch (err) {
      console.error("ScoreAnnotator addPage failed:", err);
      new Notice("Add Page failed — see console");
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
    this.history.clear();
    this.initialLoadStarted = true;
    void this.applyInitialState(file);
  }

  private async applyInitialState(file: TFile) {
    this.loadedFilePath = file.path;
    this.paperTemplate = null;
    this.paperStavesPerPage = undefined;
    const touched = new Set<number>();
    let bytes: ArrayBuffer | null = null;
    let baked: PageStrokes[] = [];

    try {
      bytes = await this.app.vault.readBinary(file);
      baked = await readStrokesFromPdf(bytes);
      const total = baked.reduce((n, p) => n + p.strokes.length, 0);
      // Track disk state independently of which source we load from — save()
      // needs this to know it should strip the baked set when the user
      // erases everything.
      this.hasBakedStrokes = total > 0;
      console.info(
        `ScoreAnnotator: loaded ${total} baked stroke(s) across ${baked.length} page(s) from ${file.path}`,
      );
    } catch (err) {
      console.warn("ScoreAnnotator: failed to read baked annotations:", err);
    }

    // Sidecar is the complete unsaved state when present — pages it omits
    // mean the user erased them. Use baked only when no sidecar exists, so
    // erased pages don't reappear from the PDF on next open.
    const sidecar = await readSidecar(this.app, file);
    const active = sidecar ?? baked;
    // Only mark strokes as baked when they came straight from the PDF. A
    // sidecar represents unsaved edits — those strokes need overlay paint.
    const fromBaked = !sidecar;
    for (const page of active) {
      const strokes = page.strokes.slice();
      this.allStrokes.set(page.pageIndex, strokes);
      if (fromBaked) {
        for (const s of strokes) this.bakedStrokes.add(s);
      }
      touched.add(page.pageIndex);
    }

    if (bytes) {
      try {
        const pdfDoc = await PDFDocument.load(bytes, {
          ignoreEncryption: true,
          throwOnInvalidObject: false,
        });
        const info = parsePaperSubject(pdfDoc.getSubject());
        if (info) {
          this.paperTemplate = info.template;
          this.paperStavesPerPage = info.stavesPerPage;
        }
      } catch (err) {
        console.warn("ScoreAnnotator: failed to read PDF metadata:", err);
      }
    }

    const wantAddPage = this.paperTemplate !== null;
    if (wantAddPage !== this.toolbarHasAddPage) {
      this.buildToolbar(this.leaf.view.containerEl, wantAddPage);
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

    // Bind pages now in range. PDF.js may wipe `.page` children after its
    // initial render (e.g., when it re-lays out at a different zoom), which
    // takes our canvas with it. The bindings map still has the page as a
    // key, so we'd otherwise skip rebinding. Treat a missing canvas as
    // "not bound" and reattach.
    for (const pageEl of shouldBind) {
      const existing = this.bindings.get(pageEl);
      if (existing && pageEl.contains(existing.canvas)) continue;
      if (existing) this.unbindPage(pageEl, existing);
      const attr = pageEl.getAttribute("data-page-number");
      const pageIndex = attr ? parseInt(attr, 10) - 1 : 0;
      this.bindPage(pageEl, pageIndex);
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
    if (this.drawMode) canvas.classList.add("score-annotator-draw-mode");
    pageEl.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const binding: PageBinding = {
      pageEl,
      canvas,
      ctx,
      pageIndex,
      resizeObserver: new ResizeObserver(() => this.resizeCanvas(binding)),
      // PDF.js renders the annotation layer asynchronously and may rebuild
      // it after a save reload. Watch the page for new ink nodes and hide
      // them as they appear — CSS handles the common selectors, this is
      // belt-and-suspenders for variants we haven't seen. Also catches
      // PDF.js leaving a second canvasWrapper/textLayer after re-render.
      inkObserver: new MutationObserver(() => {
        this.hideStaleLayers(pageEl);
        this.hideInkInPage(pageEl);
      }),
      currentStroke: null,
      eraseRemoved: new Set(),
      eraseAdded: new Set(),
      anyBakedErased: false,
    };
    binding.resizeObserver.observe(pageEl);
    binding.inkObserver.observe(pageEl, { childList: true, subtree: true });
    this.hideStaleLayers(pageEl);
    this.hideInkInPage(pageEl);
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
    binding.inkObserver.disconnect();
    binding.canvas.remove();
    this.bindings.delete(pageEl);
  }

  // PDF.js sometimes appends a fresh canvasWrapper/textLayer/annotationLayer
  // when re-rendering a page after a file change (e.g., after we save) without
  // removing the previous set. Both the old and new canvases render the page
  // bitmap with our /AP /N ink baked in, producing visible doubling. Hide all
  // but the last of each layer type so only the freshest render is visible.
  private hideStaleLayers(pageEl: HTMLElement) {
    const layers = [".canvasWrapper", ".textLayer", ".annotationLayer"];
    for (const sel of layers) {
      const nodes = pageEl.querySelectorAll<HTMLElement>(`:scope > ${sel}`);
      if (nodes.length <= 1) continue;
      for (let i = 0; i < nodes.length - 1; i++) {
        if (nodes[i].style.display === "none") continue;
        nodes[i].style.display = "none";
      }
    }
  }

  // Hide PDF.js's own render of ink annotations. The canvas overlay is the
  // source of truth (and the only renderer that supports the eraser), so any
  // ink the viewer paints from disk is a duplicate of what we're already
  // drawing. CSS handles the common cases; this catches class-name variants
  // and elements added after the initial annotation-layer build.
  private hideInkInPage(pageEl: HTMLElement) {
    const candidates = pageEl.querySelectorAll<HTMLElement>(
      '.annotationLayer .inkAnnotation, .annotationLayer .ink, ' +
        '.annotationLayer [data-annotation-type="ink"], ' +
        '.annotationEditorLayer .inkEditor, ' +
        '.annotationEditorLayer .inkAnnotationEditor, ' +
        '.annotationEditorLayer [data-editor-type="ink"]',
    );
    for (const el of Array.from(candidates)) {
      if (el.style.display === "none") continue;
      el.style.display = "none";
      console.count("SA:hideInkInPage:hidden");
    }
    this.logAnnotationLayerOnce(pageEl);
  }

  // One-time diagnostic: dump the annotation layer's HTML so we can see the
  // exact class names PDF.js used and write a precise hider for them. Only
  // logs the first non-empty layer we encounter per session.
  private static layerDumpSent = false;
  private logAnnotationLayerOnce(pageEl: HTMLElement) {
    if (OverlayController.layerDumpSent) return;
    const layer = pageEl.querySelector<HTMLElement>(
      ".annotationLayer, .annotationEditorLayer",
    );
    if (!layer || layer.children.length === 0) return;
    OverlayController.layerDumpSent = true;
    console.info(
      "ScoreAnnotator: annotation layer DOM dump (paste this if doubling persists):\n" +
        layer.outerHTML.slice(0, 4000),
    );
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

  private isTextInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
    return (el as HTMLElement).isContentEditable === true;
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
    // Palm rejection: a resting hand touch must not start a stroke while pen is drawing.
    if (e.pointerType === "touch" && this.penStrokeActive) return;
    // Tool for this gesture is decided once, here. The hold-key override
    // never mutates `tool` — keyup mid-stroke must not switch tools.
    const erasing = this.eraserKeyHeld || this.tool === "eraser";
    // Pen always draws. Mouse/touch only draw in draw mode — except the
    // eraser override, which must work in pan mode too so erasing never
    // requires switching modes first.
    if (e.pointerType !== "pen" && !this.drawMode && !erasing) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (b.canvas.width === 0 || b.canvas.height === 0) this.resizeCanvas(b);
    b.canvas.setPointerCapture(e.pointerId);
    const p = this.pointFromEvent(e, b);
    if (erasing) {
      b.eraseRemoved = new Set();
      b.eraseAdded = new Set();
      b.anyBakedErased = false;
      this.eraseAt(p, b);
      b.currentStroke = {
        tool: "eraser",
        color: "",
        width: this.penWidth,
        opacity: 1,
        points: [p],
      };
    } else {
      const useHighlighter = this.tool === "highlighter";
      const pressure = pointerPressure(e);
      b.currentStroke = {
        tool: "pen",
        kind: useHighlighter ? "highlighter" : "pen",
        color: this.colors[this.activeColorIndex] ?? "#000000",
        width: useHighlighter ? this.highlighterWidth : this.penWidth,
        opacity: useHighlighter ? this.highlighterOpacity : this.penOpacity,
        points: [{ x: p.x, y: p.y, p: pressure }],
      };
      if (e.pointerType === "pen") this.penStrokeActive = true;
    }
    this.redraw(b);
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent, b: PageBinding) {
    if (!b.currentStroke) {
      // Hover only (no gesture in progress): keep the cursor's crosshair
      // in sync with "can this input draw right now" — pen always can.
      b.canvas.classList.toggle("score-annotator-pen-hover", e.pointerType === "pen");
      return;
    }
    // Palm rejection during pen stroke.
    if (e.pointerType === "touch" && this.penStrokeActive) {
      e.preventDefault();
      return;
    }
    // Drain coalesced events for full tablet sample rate; fall back to [e].
    const events: PointerEvent[] =
      typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    if (events.length === 0) events.push(e);

    if (b.currentStroke.tool === "eraser") {
      for (const ev of events) this.eraseAt(this.pointFromEvent(ev, b), b);
    } else {
      for (const ev of events) {
        const p = this.pointFromEvent(ev, b);
        b.currentStroke.points.push({ x: p.x, y: p.y, p: pointerPressure(ev) });
      }
    }
    this.redraw(b);
    e.preventDefault();
  }

  private onPointerUp(e: PointerEvent, b: PageBinding) {
    if (!b.currentStroke) return;
    const wasPen = b.currentStroke.tool === "pen";
    const wasEraser = b.currentStroke.tool === "eraser";
    if (wasPen && b.currentStroke.points.length > 0) {
      const rect = b.canvas.getBoundingClientRect();
      b.currentStroke.points = decimateStroke(
        b.currentStroke.points,
        rect.width || 1,
        rect.height || 1,
        STROKE_DECIMATE_TOLERANCE_PX,
      );
      const strokes = this.allStrokes.get(b.pageIndex) ?? [];
      strokes.push(b.currentStroke);
      this.allStrokes.set(b.pageIndex, strokes);
      this.history.push({ type: "add", pageIndex: b.pageIndex, stroke: b.currentStroke });
    } else if (
      wasEraser &&
      (b.eraseRemoved.size > 0 || b.eraseAdded.size > 0)
    ) {
      // One erase gesture → one history entry (undo restores all at once).
      this.history.push({
        type: "erase",
        pageIndex: b.pageIndex,
        removed: Array.from(b.eraseRemoved),
        added: Array.from(b.eraseAdded),
        anyBaked: b.anyBakedErased,
      });
      b.eraseRemoved = new Set();
      b.eraseAdded = new Set();
      b.anyBakedErased = false;
    }
    if (e.pointerType === "pen") this.penStrokeActive = false;
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

  // Segment eraser: removes only the points (and thin-stroke segments)
  // inside the eraser radius, splitting each touched stroke's survivors
  // into contiguous runs that become their own strokes. A stroke with
  // nothing hit is left untouched (same object, not replaced).
  private eraseAt(p: Point, b: PageBinding) {
    const rect = b.canvas.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    const r2 = this.eraserRadius * this.eraserRadius;
    const strokes = this.allStrokes.get(b.pageIndex) ?? [];
    const next: Stroke[] = [];

    const hitPos = (x: number, y: number) => {
      const dx = (x - p.x) * w;
      const dy = (y - p.y) * h;
      return dx * dx + dy * dy <= r2;
    };

    for (const s of strokes) {
      const pts = s.points;
      const n = pts.length;
      const hitPoint = new Array<boolean>(n);
      let anyHit = false;
      for (let i = 0; i < n; i++) {
        hitPoint[i] = hitPos(pts[i].x, pts[i].y);
        if (hitPoint[i]) anyHit = true;
      }
      // Also test segment midpoints so fast, sparsely-sampled strokes can't
      // slip a whole segment through the eraser gap between two points.
      const cutAfter = new Array<boolean>(Math.max(0, n - 1)).fill(false);
      for (let i = 0; i < n - 1; i++) {
        if (hitPoint[i] || hitPoint[i + 1]) continue;
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        if (hitPos(mx, my)) {
          cutAfter[i] = true;
          anyHit = true;
        }
      }

      if (!anyHit) {
        next.push(s);
        continue;
      }

      // Bookkeeping: a fragment created earlier in this same gesture that
      // gets erased further is dropped from `added` rather than recorded
      // in `removed` — undo should only ever restore pre-gesture strokes.
      if (b.eraseAdded.has(s)) {
        b.eraseAdded.delete(s);
      } else {
        b.eraseRemoved.add(s);
        if (this.bakedStrokes.has(s)) b.anyBakedErased = true;
      }

      let current: Point[] = [];
      const runs: Point[][] = [];
      for (let i = 0; i < n; i++) {
        if (hitPoint[i]) {
          if (current.length) runs.push(current);
          current = [];
          continue;
        }
        current.push(pts[i]);
        if (cutAfter[i]) {
          runs.push(current);
          current = [];
        }
      }
      if (current.length) runs.push(current);

      for (const run of runs) {
        if (run.length < 2) continue;
        // New object identity — never in bakedStrokes, so it renders via
        // the overlay and saves fresh, same as any other unbaked stroke.
        const fragment: Stroke = { ...s, points: run };
        b.eraseAdded.add(fragment);
        next.push(fragment);
      }
    }

    this.allStrokes.set(b.pageIndex, next);
    // Baked strokes are painted by PDF.js from /AP /N; removing them from
    // our memory doesn't make them disappear visually. Trigger a debounced
    // re-save so the PDF gets rewritten without them and PDF.js reloads.
    if (b.anyBakedErased) this.scheduleBakedRewrite();
  }

  private scheduleBakedRewrite() {
    if (this.bakedRewriteTimer !== null) {
      window.clearTimeout(this.bakedRewriteTimer);
    }
    this.bakedRewriteTimer = window.setTimeout(() => {
      this.bakedRewriteTimer = null;
      void this.save("PDF updated");
    }, 800);
  }

  private applyUndo() {
    const action = this.history.undo();
    if (!action) return;
    if (action.type === "add") {
      const strokes = this.allStrokes.get(action.pageIndex) ?? [];
      const idx = strokes.lastIndexOf(action.stroke);
      if (idx !== -1) strokes.splice(idx, 1);
      this.allStrokes.set(action.pageIndex, strokes);
      const b = this.bindingForPageIndex(action.pageIndex);
      if (b) this.redraw(b);
      this.scheduleAutosave();
    } else {
      // erase undo: drop this gesture's fragments, restore the originals
      const toRemove = new Set(action.added);
      const strokes = (this.allStrokes.get(action.pageIndex) ?? []).filter(
        (s) => !toRemove.has(s),
      );
      strokes.push(...action.removed);
      this.allStrokes.set(action.pageIndex, strokes);
      const b = this.bindingForPageIndex(action.pageIndex);
      if (b) this.redraw(b);
      if (action.anyBaked) {
        // Re-save so the PDF regains the strokes.
        this.scheduleBakedRewrite();
      } else {
        this.scheduleAutosave();
      }
    }
  }

  private applyRedo() {
    const action = this.history.redo();
    if (!action) return;
    if (action.type === "add") {
      const strokes = this.allStrokes.get(action.pageIndex) ?? [];
      strokes.push(action.stroke);
      this.allStrokes.set(action.pageIndex, strokes);
      const b = this.bindingForPageIndex(action.pageIndex);
      if (b) this.redraw(b);
      this.scheduleAutosave();
    } else {
      // erase redo: remove the originals again, bring the fragments back
      const toRemove = new Set(action.removed);
      const strokes = (this.allStrokes.get(action.pageIndex) ?? []).filter(
        (s) => !toRemove.has(s),
      );
      strokes.push(...action.added);
      this.allStrokes.set(action.pageIndex, strokes);
      const b = this.bindingForPageIndex(action.pageIndex);
      if (b) this.redraw(b);
      if (action.anyBaked) {
        this.scheduleBakedRewrite();
      } else {
        this.scheduleAutosave();
      }
    }
  }

  private redraw(b: PageBinding) {
    const rect = b.pageEl.getBoundingClientRect();
    b.ctx.clearRect(0, 0, rect.width, rect.height);
    const strokes = this.allStrokes.get(b.pageIndex) ?? [];
    for (const stroke of strokes) {
      if (this.bakedStrokes.has(stroke)) continue;
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
    if (strokeKind(stroke) === "highlighter") {
      paintHighlighterStroke(ctx, stroke, w, h);
    } else {
      paintPenStroke(ctx, stroke, w, h);
    }
  }
}

// Returns a normalised pressure value for a pointer event.
// Mouse/touch report 0 or a fixed value — treat as 0.5 so perfect-freehand
// uses simulatePressure and produces uniform-width strokes for those inputs.
function pointerPressure(e: PointerEvent): number {
  if (e.pointerType === "mouse" || e.pointerType === "touch") return 0.5;
  return Math.max(0, Math.min(1, e.pressure));
}