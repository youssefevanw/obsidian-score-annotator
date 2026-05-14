import { Tool } from "./types";

export interface ToolbarOpts {
  isActive: () => boolean;
  onToggle: () => void;
  getTool: () => Tool;
  setTool: (t: Tool) => void;
  getColor: () => string;
  setColor: (c: string) => void;
  getWidth: () => number;
  setWidth: (w: number) => void;
  getOpacity: () => number;
  setOpacity: (o: number) => void;
  onSave: () => void;
}

export class Toolbar {
  private root: HTMLDivElement;
  private toggleBtn!: HTMLButtonElement;
  private penBtn!: HTMLButtonElement;
  private eraserBtn!: HTMLButtonElement;

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
    this.toggleBtn.textContent = active ? "Annotating" : "Annotate";
    this.penBtn.classList.toggle("is-active", this.opts.getTool() === "pen");
    this.eraserBtn.classList.toggle(
      "is-active",
      this.opts.getTool() === "eraser",
    );
  }

  private build() {
    this.toggleBtn = this.mkBtn("Annotate", () => {
      this.opts.onToggle();
      this.refresh();
    });

    this.penBtn = this.mkBtn("Pen", () => {
      this.opts.setTool("pen");
      this.refresh();
    });

    this.eraserBtn = this.mkBtn("Eraser", () => {
      this.opts.setTool("eraser");
      this.refresh();
    });

    const color = document.createElement("input");
    color.type = "color";
    color.className = "score-annotator-color";
    color.value = this.opts.getColor();
    color.addEventListener("input", () => this.opts.setColor(color.value));

    const widthLabel = document.createElement("label");
    widthLabel.className = "score-annotator-width";
    widthLabel.title = "Stroke width";
    const width = document.createElement("input");
    width.type = "range";
    width.min = "1";
    width.max = "12";
    width.step = "1";
    width.value = String(this.opts.getWidth());
    width.addEventListener("input", () =>
      this.opts.setWidth(Number(width.value)),
    );
    widthLabel.appendChild(width);

    const opacityLabel = document.createElement("label");
    opacityLabel.className = "score-annotator-opacity";
    opacityLabel.title = "Opacity";
    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0.1";
    opacity.max = "1";
    opacity.step = "0.05";
    opacity.value = String(this.opts.getOpacity());
    opacity.addEventListener("input", () =>
      this.opts.setOpacity(Number(opacity.value)),
    );
    opacityLabel.appendChild(opacity);

    const saveBtn = this.mkBtn("Save", () => this.opts.onSave());
    saveBtn.classList.add("score-annotator-save");
    saveBtn.title = "Save annotations into the PDF";

    this.root.append(
      this.toggleBtn,
      this.penBtn,
      this.eraserBtn,
      color,
      widthLabel,
      opacityLabel,
      saveBtn,
    );
    this.refresh();
  }

  private mkBtn(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "score-annotator-btn";
    b.addEventListener("click", onClick);
    return b;
  }
}
