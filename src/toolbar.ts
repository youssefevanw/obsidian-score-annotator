import { setIcon } from "obsidian";
import { Tool } from "./types";

export interface ToolbarOpts {
  isActive: () => boolean;
  onToggle: () => void;

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

  onSave: () => void;
  onAddPage?: () => void;
}

// Width presets per tool (in PDF points / CSS px).
const PEN_WIDTHS = [0.5, 1, 2, 3.5, 6] as const;
const HIGHLIGHTER_WIDTHS = [6, 12, 20] as const;

// Opacity presets for the highlighter (pen is always 1.0).
const HIGHLIGHTER_OPACITIES = [0.25, 0.5, 0.75] as const;

const SWATCH_COUNT = 5;

export class Toolbar {
  private root: HTMLDivElement;
  private toggleBtn!: HTMLButtonElement;
  private penBtn!: HTMLButtonElement;
  private highlighterBtn!: HTMLButtonElement;
  private eraserBtn!: HTMLButtonElement;
  private swatches: HTMLInputElement[] = [];
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
  }

  refresh() {
    const active = this.opts.isActive();
    this.toggleBtn.classList.toggle("is-active", active);
    this.toggleBtn.title = active ? "Annotating (click to stop)" : "Annotate";

    const tool = this.opts.getTool();
    this.penBtn.classList.toggle("is-active", tool === "pen");
    this.highlighterBtn.classList.toggle("is-active", tool === "highlighter");
    this.eraserBtn.classList.toggle("is-active", tool === "eraser");

    const colors = this.opts.getColors();
    const activeIdx = this.opts.getActiveColorIndex();
    for (let i = 0; i < this.swatches.length; i++) {
      const sw = this.swatches[i];
      const target = colors[i];
      if (target && sw.value !== target) sw.value = target;
      sw.classList.toggle("is-active", i === activeIdx);
    }

    this.refreshWidthDots(tool);
    this.refreshOpacityChips(tool);
  }

  private refreshWidthDots(tool: Tool) {
    const presets = tool === "highlighter" ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
    const current =
      tool === "highlighter"
        ? this.opts.getHighlighterWidth()
        : this.opts.getPenWidth();

    // Rebuild the dot row only when the preset set has changed length
    // (pen↔highlighter switch). Using data attribute to track.
    const currentLen = this.widthDotsEl.dataset.len ?? "";
    if (currentLen !== String(presets.length)) {
      this.widthDotsEl.innerHTML = "";
      this.widthDots = [];
      for (const w of presets) {
        const btn = document.createElement("button");
        btn.className = "score-annotator-width-dot";
        btn.title = `${w} pt`;
        btn.dataset.width = String(w);

        const inner = document.createElement("span");
        inner.className = "score-annotator-width-dot-inner";
        // Visible diameter: actual stroke width, minimum 2px so hairline shows.
        const sizePx = Math.max(2, w);
        inner.style.width = `${sizePx}px`;
        inner.style.height = `${sizePx}px`;
        btn.appendChild(inner);

        btn.addEventListener("click", () => {
          if (this.opts.getTool() === "highlighter") {
            this.opts.setHighlighterWidth(w);
          } else {
            this.opts.setPenWidth(w);
          }
          this.refresh();
        });
        this.widthDots.push(btn);
        this.widthDotsEl.appendChild(btn);
      }
      this.widthDotsEl.dataset.len = String(presets.length);
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
    this.toggleBtn = this.mkBtn("pencil", "Annotate", () => {
      this.opts.onToggle();
      this.refresh();
    });

    this.penBtn = this.mkBtn("pen-tool", "Pen", () => {
      this.opts.setTool("pen");
      this.refresh();
    });
    this.highlighterBtn = this.mkBtn("highlighter", "Highlighter", () => {
      this.opts.setTool("highlighter");
      this.refresh();
    });
    this.eraserBtn = this.mkBtn("eraser", "Eraser", () => {
      this.opts.setTool("eraser");
      this.refresh();
    });

    // Color swatches
    const swatchRow = document.createElement("div");
    swatchRow.className = "score-annotator-swatches";
    const initialColors = this.opts.getColors();
    for (let i = 0; i < SWATCH_COUNT; i++) {
      const sw = document.createElement("input");
      sw.type = "color";
      sw.className = "score-annotator-swatch";
      sw.value = initialColors[i] ?? "#000000";
      sw.title = `Color ${i + 1}`;
      sw.addEventListener("click", () => {
        this.opts.setActiveColorIndex(i);
        this.refresh();
      });
      sw.addEventListener("input", () => {
        this.opts.setColor(i, sw.value);
        this.refresh(); // opacity chips may need new color
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
