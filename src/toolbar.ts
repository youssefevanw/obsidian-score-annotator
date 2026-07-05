import { setIcon } from "obsidian";
import { Tool } from "./types";
import { ERASER_RADII, HIGHLIGHTER_WIDTHS, PEN_WIDTHS } from "./presets";

export interface ToolbarOpts {
  isDrawMode: () => boolean;
  onToggleDrawMode: () => void;

  getTool: () => Tool;
  setTool: (t: Tool) => void;

  getColors: () => string[];
  setColor: (index: number, c: string) => void;
  getActiveColorIndex: () => number;
  setActiveColorIndex: (i: number) => void;

  getPenWidth: () => number;
  setPenWidth: (w: number) => void;
  getHighlighterWidth: () => number;
  setHighlighterWidth: (w: number) => void;
  getHighlighterOpacity: () => number;
  setHighlighterOpacity: (o: number) => void;
  getEraserRadius: () => number;
  setEraserRadius: (r: number) => void;

  // True while the hold-key eraser override is active. Drives the eraser
  // button highlight without touching getTool()'s value.
  isEraserOverride: () => boolean;

  onSave: () => void;
  onAddPage?: () => void;
}

// Opacity presets for the highlighter (pen is always 1.0).
const HIGHLIGHTER_OPACITIES = [0.25, 0.5, 0.75] as const;

const SWATCH_COUNT = 6;

// Q W E R T labels, in preset order — must match SIZE_KEY_CODES in
// overlay.ts so tooltips reflect the keys that actually work.
const SIZE_KEY_LABELS = ["Q", "W", "E", "R", "T"] as const;

const SWATCH_HOLD_MS = 500;
const SWATCH_HOLD_TOLERANCE_PX = 4;

export class Toolbar {
  private root: HTMLDivElement;
  private toggleBtn!: HTMLButtonElement;
  private penBtn!: HTMLButtonElement;
  private highlighterBtn!: HTMLButtonElement;
  private eraserBtn!: HTMLButtonElement;
  private swatches: HTMLButtonElement[] = [];
  private colorInput!: HTMLInputElement;
  private widthDotsEl!: HTMLDivElement;
  private widthDots: HTMLButtonElement[] = [];
  private opacityChipsEl!: HTMLDivElement;
  private opacityChips: HTMLButtonElement[] = [];

  constructor(private host: HTMLElement, private opts: ToolbarOpts) {
    this.root = document.createElement("div");
    this.root.className = "score-annotator-toolbar";
    this.build();
    host.appendChild(this.root);
  }

  destroy() {
    this.root.remove();
    this.colorInput.remove();
  }

  refresh() {
    const drawMode = this.opts.isDrawMode();
    setIcon(this.toggleBtn, drawMode ? "pencil" : "hand");
    this.toggleBtn.classList.toggle("is-active", drawMode);
    this.toggleBtn.title = drawMode
      ? "Draw mode (mouse/touch) — stylus always draws"
      : "Pan mode (mouse/touch) — stylus always draws";
    this.toggleBtn.setAttribute("aria-label", this.toggleBtn.title);

    const tool = this.opts.getTool();
    const eraserOverride = this.opts.isEraserOverride();
    this.penBtn.classList.toggle("is-active", !eraserOverride && tool === "pen");
    this.highlighterBtn.classList.toggle(
      "is-active",
      !eraserOverride && tool === "highlighter",
    );
    this.eraserBtn.classList.toggle(
      "is-active",
      eraserOverride || tool === "eraser",
    );

    const colors = this.opts.getColors();
    const activeIdx = this.opts.getActiveColorIndex();
    for (let i = 0; i < this.swatches.length; i++) {
      const sw = this.swatches[i];
      sw.style.background = colors[i] ?? "#000000";
      sw.classList.toggle("is-active", i === activeIdx);
    }

    this.refreshWidthDots(tool);
    this.refreshOpacityChips(tool);
  }

  private refreshWidthDots(tool: Tool) {
    const presets =
      tool === "highlighter"
        ? HIGHLIGHTER_WIDTHS
        : tool === "eraser"
          ? ERASER_RADII
          : PEN_WIDTHS;
    const current =
      tool === "highlighter"
        ? this.opts.getHighlighterWidth()
        : tool === "eraser"
          ? this.opts.getEraserRadius()
          : this.opts.getPenWidth();

    // Rebuild the dot row only when the preset set actually changed. Keyed
    // by the preset values themselves (not just length) — highlighter and
    // eraser both have 3 presets, so a length-only check would miss the
    // switch between them.
    const unit = tool === "eraser" ? "px" : "pt";
    const key = presets.join(",");
    if (this.widthDotsEl.dataset.key !== key) {
      this.widthDotsEl.innerHTML = "";
      this.widthDots = [];
      presets.forEach((w, i) => {
        const btn = document.createElement("button");
        btn.className = "score-annotator-width-dot";
        btn.title = `${w} ${unit} — key: ${SIZE_KEY_LABELS[i]}`;
        btn.dataset.width = String(w);

        const inner = document.createElement("span");
        inner.className = "score-annotator-width-dot-inner";
        // Visible diameter: actual stroke width for pen/highlighter (min
        // 2px so hairline shows); eraser radii are much larger, so scale
        // them down to fit the same dot button.
        const sizePx =
          tool === "eraser" ? Math.min(20, Math.max(4, w / 2)) : Math.max(2, w);
        inner.style.width = `${sizePx}px`;
        inner.style.height = `${sizePx}px`;
        btn.appendChild(inner);

        btn.addEventListener("click", () => {
          const t = this.opts.getTool();
          if (t === "highlighter") {
            this.opts.setHighlighterWidth(w);
          } else if (t === "eraser") {
            this.opts.setEraserRadius(w);
          } else {
            this.opts.setPenWidth(w);
          }
          this.refresh();
        });
        this.widthDots.push(btn);
        this.widthDotsEl.appendChild(btn);
      });
      this.widthDotsEl.dataset.key = key;
    }

    // Mark the active dot (nearest preset to current value).
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < presets.length; i++) {
      const diff = Math.abs(presets[i] - current);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    this.widthDots.forEach((d, i) => d.classList.toggle("is-active", i === bestIdx));
  }

  private refreshOpacityChips(tool: Tool) {
    const show = tool === "highlighter";
    this.opacityChipsEl.style.display = show ? "" : "none";
    if (!show) return;

    const current = this.opts.getHighlighterOpacity();
    const activeColor = this.opts.getColors()[this.opts.getActiveColorIndex()] ?? "#000000";

    this.opacityChips.forEach((chip, i) => {
      const alpha = HIGHLIGHTER_OPACITIES[i];
      chip.style.background = hexToRgba(activeColor, alpha);
      chip.classList.toggle("is-active", Math.abs(current - alpha) < 0.01);
    });
  }

  private build() {
    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.className = "score-annotator-color-input-hidden";
    document.body.appendChild(this.colorInput);

    // Icon/title are state-dependent — set for real in refresh(), called
    // at the end of build().
    this.toggleBtn = this.mkBtn("pencil", "", () => {
      this.opts.onToggleDrawMode();
      this.refresh();
    });

    this.penBtn = this.mkBtn("pen-tool", "Pen — key: B", () => {
      this.opts.setTool("pen");
      this.refresh();
    });
    this.highlighterBtn = this.mkBtn("highlighter", "Highlighter — key: H", () => {
      this.opts.setTool("highlighter");
      this.refresh();
    });
    this.eraserBtn = this.mkBtn("eraser", "Eraser — hold: X", () => {
      this.opts.setTool("eraser");
      this.refresh();
    });

    // Color swatches — plain buttons (not <input type="color">) so a single
    // click just selects the slot. Double-click, or a ≥500ms pointer-hold
    // without movement, opens the OS color picker via the one hidden
    // <input type="color"> created above.
    const swatchRow = document.createElement("div");
    swatchRow.className = "score-annotator-swatches";
    const initialColors = this.opts.getColors();
    for (let i = 0; i < SWATCH_COUNT; i++) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "score-annotator-swatch";
      sw.style.background = initialColors[i] ?? "#000000";
      sw.title = `Color ${i + 1} — key: ${i + 1}`;

      let holdTimer: number | null = null;
      let downX = 0;
      let downY = 0;
      const cancelHold = () => {
        if (holdTimer !== null) {
          window.clearTimeout(holdTimer);
          holdTimer = null;
        }
      };
      sw.addEventListener("pointerdown", (e) => {
        downX = e.clientX;
        downY = e.clientY;
        cancelHold();
        holdTimer = window.setTimeout(() => {
          holdTimer = null;
          this.openColorEditor(i, sw);
        }, SWATCH_HOLD_MS);
      });
      sw.addEventListener("pointermove", (e) => {
        if (holdTimer === null) return;
        if (
          Math.abs(e.clientX - downX) > SWATCH_HOLD_TOLERANCE_PX ||
          Math.abs(e.clientY - downY) > SWATCH_HOLD_TOLERANCE_PX
        ) {
          cancelHold();
        }
      });
      sw.addEventListener("pointerup", cancelHold);
      sw.addEventListener("pointerleave", cancelHold);
      sw.addEventListener("pointercancel", cancelHold);

      sw.addEventListener("click", () => {
        this.opts.setActiveColorIndex(i);
        this.refresh();
      });
      sw.addEventListener("dblclick", (e) => {
        e.preventDefault();
        this.openColorEditor(i, sw);
      });

      this.swatches.push(sw);
      swatchRow.appendChild(sw);
    }

    // Width dots container (populated in refreshWidthDots)
    this.widthDotsEl = document.createElement("div");
    this.widthDotsEl.className = "score-annotator-width-dots";

    // Opacity chips (highlighter-only, built once)
    this.opacityChipsEl = document.createElement("div");
    this.opacityChipsEl.className = "score-annotator-opacity-chips";
    for (const alpha of HIGHLIGHTER_OPACITIES) {
      const chip = document.createElement("button");
      chip.className = "score-annotator-opacity-chip";
      chip.title = `${Math.round(alpha * 100)}%`;
      chip.addEventListener("click", () => {
        this.opts.setHighlighterOpacity(alpha);
        this.refresh();
      });
      this.opacityChips.push(chip);
      this.opacityChipsEl.appendChild(chip);
    }

    const children: HTMLElement[] = [
      this.toggleBtn,
      mkDivider(),
      this.penBtn,
      this.highlighterBtn,
      this.eraserBtn,
      mkDivider(),
      swatchRow,
      mkDivider(),
      this.widthDotsEl,
      this.opacityChipsEl,
    ];

    if (this.opts.onAddPage) {
      children.push(mkDivider());
      const addBtn = this.mkBtn(
        "file-plus",
        "Append a new page using the same template",
        () => this.opts.onAddPage!(),
      );
      addBtn.classList.add("score-annotator-add-page");
      children.push(addBtn);
    }

    children.push(mkDivider());
    const saveBtn = this.mkBtn("save", "Save annotations into the PDF", () =>
      this.opts.onSave(),
    );
    saveBtn.classList.add("score-annotator-save");
    children.push(saveBtn);

    this.root.append(...children);
    this.refresh();
  }

  // Opens the OS color picker for swatch slot `i`, positioning the single
  // hidden <input type="color"> over that swatch and forwarding its input
  // events back to the slot.
  private openColorEditor(i: number, swatchEl: HTMLButtonElement) {
    this.opts.setActiveColorIndex(i);
    const rect = swatchEl.getBoundingClientRect();
    this.colorInput.style.left = `${rect.left}px`;
    this.colorInput.style.top = `${rect.top}px`;
    this.colorInput.value = this.opts.getColors()[i] ?? "#000000";
    this.colorInput.oninput = () => {
      this.opts.setColor(i, this.colorInput.value);
      this.refresh();
    };
    this.refresh();
    this.colorInput.click();
  }

  private mkBtn(
    icon: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const b = document.createElement("button");
    setIcon(b, icon);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.className = "score-annotator-btn";
    b.addEventListener("click", onClick);
    return b;
  }
}

function mkDivider(): HTMLElement {
  const d = document.createElement("div");
  d.className = "score-annotator-divider";
  return d;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
