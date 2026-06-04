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
  getPenOpacity: () => number;
  setPenOpacity: (o: number) => void;
  getHighlighterWidth: () => number;
  setHighlighterWidth: (w: number) => void;
  getHighlighterOpacity: () => number;
  setHighlighterOpacity: (o: number) => void;

  onSave: () => void;
  onAddPage?: () => void;
}

const SWATCH_COUNT = 5;

export class Toolbar {
  private root: HTMLDivElement;
  private toggleBtn!: HTMLButtonElement;
  private penBtn!: HTMLButtonElement;
  private highlighterBtn!: HTMLButtonElement;
  private eraserBtn!: HTMLButtonElement;
  private swatches: HTMLInputElement[] = [];
  private widthInput!: HTMLInputElement;
  private opacityInput!: HTMLInputElement;

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

    const writing = writingTool(tool);
    this.widthInput.value = String(
      writing === "highlighter"
        ? this.opts.getHighlighterWidth()
        : this.opts.getPenWidth(),
    );
    this.opacityInput.value = String(
      writing === "highlighter"
        ? this.opts.getHighlighterOpacity()
        : this.opts.getPenOpacity(),
    );
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

    const swatchRow = document.createElement("div");
    swatchRow.className = "score-annotator-swatches";
    const initialColors = this.opts.getColors();
    for (let i = 0; i < SWATCH_COUNT; i++) {
      const sw = document.createElement("input");
      sw.type = "color";
      sw.className = "score-annotator-swatch";
      sw.value = initialColors[i] ?? "#000000";
      sw.title = `Color ${i + 1}`;
      // Native color inputs open the picker on click. Make that same click
      // also activate the swatch, so the visible "selected" state always
      // matches the color about to be used.
      sw.addEventListener("click", () => {
        this.opts.setActiveColorIndex(i);
        this.refresh();
      });
      sw.addEventListener("input", () => {
        this.opts.setColor(i, sw.value);
      });
      this.swatches.push(sw);
      swatchRow.appendChild(sw);
    }

    this.widthInput = document.createElement("input");
    this.widthInput.type = "range";
    this.widthInput.min = "1";
    this.widthInput.max = "12";
    this.widthInput.step = "1";
    this.widthInput.title = "Stroke width";
    this.widthInput.className = "score-annotator-width-input";
    this.widthInput.setAttribute("orient", "vertical");
    this.widthInput.addEventListener("input", () => {
      const v = Number(this.widthInput.value);
      if (writingTool(this.opts.getTool()) === "highlighter") {
        this.opts.setHighlighterWidth(v);
      } else {
        this.opts.setPenWidth(v);
      }
    });
    const widthLabel = document.createElement("label");
    widthLabel.className = "score-annotator-width";
    widthLabel.title = "Stroke width";
    widthLabel.appendChild(this.widthInput);

    this.opacityInput = document.createElement("input");
    this.opacityInput.type = "range";
    this.opacityInput.min = "0.1";
    this.opacityInput.max = "1";
    this.opacityInput.step = "0.05";
    this.opacityInput.title = "Opacity";
    this.opacityInput.className = "score-annotator-opacity-input";
    this.opacityInput.setAttribute("orient", "vertical");
    this.opacityInput.addEventListener("input", () => {
      const v = Number(this.opacityInput.value);
      if (writingTool(this.opts.getTool()) === "highlighter") {
        this.opts.setHighlighterOpacity(v);
      } else {
        this.opts.setPenOpacity(v);
      }
    });
    const opacityLabel = document.createElement("label");
    opacityLabel.className = "score-annotator-opacity";
    opacityLabel.title = "Opacity";
    opacityLabel.appendChild(this.opacityInput);

    const children: HTMLElement[] = [
      this.toggleBtn,
      this.penBtn,
      this.highlighterBtn,
      this.eraserBtn,
      swatchRow,
      widthLabel,
      opacityLabel,
    ];

    if (this.opts.onAddPage) {
      const addBtn = this.mkBtn(
        "file-plus",
        "Append a new page using the same template",
        () => this.opts.onAddPage!(),
      );
      addBtn.classList.add("score-annotator-add-page");
      children.push(addBtn);
    }

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

// Sliders only meaningfully control writing tools — when eraser is active
// they still reflect & edit pen settings so the controls never feel inert.
function writingTool(t: Tool): "pen" | "highlighter" {
  return t === "highlighter" ? "highlighter" : "pen";
}
