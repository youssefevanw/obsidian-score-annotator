# ScoreAnnotator — Paper Canvas v2
## Handoff Document
*Generated May 15, 2026*

---

## What Changed From v1

The `.sacanvas` file approach is **scrapped**. The new approach:
- "New Paper Canvas" generates a blank staff/template PDF directly in the vault
- That PDF opens in the **existing** `OverlayController` flow — no new view type needed
- All existing save/autosave/sidecar machinery is inherited for free
- `paper-canvas-view.ts` and `paper-modal.ts` from v1 are **not needed**

New features added in this session:
- **Add Page** button — appends a new page with the same template to the current PDF
- **5 color swatches** — color pickers, last clicked is active color (session-only persistence)
- **Pen tool** — thin, opaque defaults (existing behavior, renamed for clarity)
- **Highlighter tool** — wide, 50% opacity defaults; same rendering as pen (no layering)
- Both pen and highlighter width/opacity are **independently adjustable and persist per-session**

---

## Repo

`https://github.com/youssefevanw/obsidian-score-annotator`

Local path: `~/Dev/existing/obsidian-score-annotator/`

---

## Current Architecture (do not break)

```
main.ts          — plugin entry; attaches OverlayController to pdf-type leaves
src/
  overlay.ts     — OverlayController: canvas overlay on Obsidian's PDF viewer
  toolbar.ts     — Toolbar UI (pen, eraser, color, width, opacity, save)
  pdf-reader.ts  — reads InkAnnotations from PDF bytes → PageStrokes[]
  pdf-writer.ts  — writes PageStrokes[] → baked PDF bytes via pdf-lib
  sidecar.ts     — autosave JSON sidecar next to PDF file
  types.ts       — Tool, Point, Stroke, PageStrokes
```

**How the existing flow works:**
1. `main.ts` watches for `pdf`-type leaves via workspace events
2. For each PDF leaf, creates an `OverlayController` and calls `attach()`
3. `OverlayController` injects a `<canvas>` overlay on top of each `.page` element in Obsidian's PDF viewer
4. Strokes stored normalized (0..1) in `allStrokes: Map<pageIndex, Stroke[]>`
5. Save bakes strokes as InkAnnotations into the PDF via `pdf-writer.ts`
6. Autosave writes a `.scoreannotator.json` sidecar every 500ms

**Key existing types (`types.ts`):**
```typescript
type Tool = "pen" | "eraser";

interface Stroke {
  tool: Tool;
  color: string;
  width: number;
  opacity: number;
  points: Point[];
}
```

---

## What to Build

### 1. New file: `src/paper-generator.ts`

Generates a blank template PDF using pdf-lib. Called once when user creates a new paper canvas. Returns `Uint8Array`.

```typescript
export type PaperTemplate = "blank" | "staff" | "dot-grid" | "graph";

export interface PaperOptions {
  template: PaperTemplate;
  stavesPerPage?: number;  // staff only, default 12
  pageCount?: number;      // default 1
}

export async function generatePaperPdf(opts: PaperOptions): Promise<Uint8Array>
```

**Implementation:** creates a `PDFDocument`, calls `addTemplatePage()` for each page, saves.

```typescript
function addTemplatePage(pdfDoc: PDFDocument, opts: PaperOptions): void
```

Draws the template on a freshly added US Letter page using pdf-lib draw primitives.

---

**Staff template — exact layout (reverse-engineered from reference PDF):**

Page size: US Letter — `[612, 792]` pts

All measurements in PDF points. pdf-lib y-axis is **bottom-up**, so every y value
must be converted: `pdfY = 792 - y`.

| Property | Value |
|---|---|
| Left margin | 54.25 pts |
| Right margin | 54.25 pts |
| Top margin (first staff top line) | 65.05 pts |
| Bottom margin | 65.05 pts |
| Staves per page (default) | 12 |
| Lines per staff | 5 |
| Line spacing within staff | 7.07 pts |
| Staff span (top to bottom line) | 28.30 pts |
| Gap between staves | 29.30 pts |
| Line stroke width | 0.5 pts |
| Line color | `rgb(0, 0, 0)` |

```
For each staff i (0-indexed, 0..stavesPerPage-1):
  staffTopY_down = 65.05 + i * 57.60       // y increasing downward
  For each line j (0..4):
    y_down = staffTopY_down + j * 7.07
    y_pdf  = 792 - y_down                  // flip for pdf-lib
    page.drawLine({
      start: { x: 54.25, y: y_pdf },
      end:   { x: 557.75, y: y_pdf },
      thickness: 0.5,
      color: rgb(0, 0, 0),
    })
```

**Blank template:** add page, draw nothing.

**Dot-grid template:** dots every 20pts, radius 0.7pts, color `rgb(0.8, 0.8, 0.8)`, filling the page inside margins (54.25pt margins).

**Graph template:** grid lines every 20pts, color `rgb(0.87, 0.87, 0.87)`, thickness 0.5pts, inside same margins.

---

### 2. New file: `src/paper-modal.ts`

Simple modal for new paper canvas creation.

```typescript
export class NewPaperCanvasModal extends Modal {
  // Dropdown: Staff / Blank / Dot Grid / Graph Paper
  // If Staff: number input — "Staves per page" (default 12)
  // Text input: file name (default "Untitled Staff Paper")
  // OK button → calls callback(opts: PaperOptions, fileName: string)
  // Creates file in vault root (no folder picker needed for v1)
}
```

---

### 3. Modify `main.ts`

Add one command: **"New paper canvas"**

Flow:
1. Open `NewPaperCanvasModal`
2. On confirm: call `generatePaperPdf(opts)` → get `Uint8Array`
3. Create vault file at `<fileName>.pdf` (root or active file's folder)
4. Write PDF bytes with `app.vault.createBinary(path, bytes)`
5. Open the file: `app.workspace.openLinkText(path, '', true)`

The file opens as a normal PDF — `OverlayController` attaches automatically via the
existing `leaf-change` workspace event in `main.ts`. No special handling needed.

---

### 4. Modify `toolbar.ts`

This is the most significant change. Replace the current single color input and single
pen/eraser toggle with:

**New `ToolbarOpts` additions:**
```typescript
// Replace:
getColor: () => string;
setColor: (c: string) => void;

// With:
getColors: () => string[];           // array of 5 hex strings
setColor: (index: number, c: string) => void;
getActiveColorIndex: () => number;
setActiveColorIndex: (i: number) => void;

// Replace:
getTool: () => Tool;
setTool: (t: Tool) => void;
getWidth: () => number;
setWidth: (w: number) => void;
getOpacity: () => number;
setOpacity: (o: number) => void;

// With:
getTool: () => Tool;                 // "pen" | "highlighter" | "eraser"
setTool: (t: Tool) => void;
getPenWidth: () => number;
setPenWidth: (w: number) => void;
getPenOpacity: () => number;
setPenOpacity: (o: number) => void;
getHighlighterWidth: () => number;
setHighlighterWidth: (w: number) => void;
getHighlighterOpacity: () => number;
setHighlighterOpacity: (o: number) => void;

// New optional callback:
onAddPage?: () => void;              // if provided, render "Add Page" button
```

**Toolbar visual layout (left to right):**
```
[Annotate toggle] | [Pen] [Highlighter] [Eraser] | [Swatch 1][2][3][4][5] | [Width slider] [Opacity slider] | [Add Page?] [Save]
```

**Color swatches:** 5 `<input type="color">` elements. Clicking one sets it as active
(highlighted border). The active swatch's color is used for the current stroke. Each
swatch is independently editable. Default colors:
```
["#e63946", "#2d6a4f", "#1d3557", "#f4a261", "#000000"]
```

**Width/opacity sliders:** show the values for the currently active tool (pen or
highlighter). When user switches tools, sliders update to reflect that tool's current
settings. Changing a slider updates only the active tool's settings.

**"Add Page" button:** only rendered if `onAddPage` is provided in opts. Label: "Add Page".

---

### 5. Modify `overlay.ts`

**A. Update `Tool` type** (or update in `types.ts` — wherever it's cleanest):
```typescript
type Tool = "pen" | "highlighter" | "eraser";
```

**B. Replace single color/width/opacity state with:**
```typescript
private colors: string[] = ["#e63946", "#2d6a4f", "#1d3557", "#f4a261", "#000000"];
private activeColorIndex = 0;

// Pen settings
private penWidth = 2;
private penOpacity = 1.0;

// Highlighter settings
private highlighterWidth = 12;
private highlighterOpacity = 0.5;
```

**C. Update `attach()` to pass new toolbar opts** — wire all the new getters/setters.

**D. Add `onAddPage` to toolbar opts** — wire to a new `addPage()` method:

```typescript
async addPage(): Promise<void> {
  const file = this.getFile();
  if (!file) return;
  // 1. Read current PDF bytes
  // 2. Load with pdf-lib
  // 3. Determine template from existing pages (see note below)
  // 4. Call addTemplatePage() from paper-generator.ts
  // 5. Save back to vault
  // 6. Show Notice("Page added")
}
```

**Note on detecting template for Add Page:** store the template type as a PDF metadata
field when the paper PDF is first created. In `generatePaperPdf()`, set a custom
document info entry: `pdfDoc.setSubject(opts.template)`. In `addPage()`, read it back
with `pdfDoc.getSubject()` to know which template to draw. If subject is empty or
unrecognized (i.e. this is a user-uploaded PDF, not a generated one), disable the
"Add Page" button entirely — only show it for generated paper canvases.

**How to know if "Add Page" should be shown:** in `OverlayController.attach()`, after
loading the file, read the PDF subject. If it matches a known `PaperTemplate` value,
pass `onAddPage` to the toolbar; otherwise omit it. This keeps the existing PDF
annotation workflow completely clean — no "Add Page" button appears on regular PDFs.

**E. Active tool width/opacity:** update `onPointerDown` to pull the correct
width/opacity based on active tool:
```typescript
const width = this.tool === "highlighter" ? this.highlighterWidth : this.penWidth;
const opacity = this.tool === "highlighter" ? this.highlighterOpacity : this.penOpacity;
```

Highlighter uses `lineJoin = "round"` and `lineCap = "round"` same as pen — no
visual difference in cap style needed.

---

## What NOT to Change

- `pdf-reader.ts` — zero modifications
- `pdf-writer.ts` — zero modifications
- `sidecar.ts` — zero modifications

---

## Updated `types.ts`

```typescript
export type Tool = "pen" | "highlighter" | "eraser";  // add "highlighter"
// All other types unchanged
```

---

## File Structure After Changes

```
main.ts               — modified (add "New paper canvas" command)
src/
  overlay.ts          — modified (tool state, toolbar wiring, addPage)
  toolbar.ts          — modified (5 swatches, pen/highlighter, Add Page btn)
  types.ts            — modified (add "highlighter" to Tool)
  pdf-reader.ts       — unchanged
  pdf-writer.ts       — unchanged
  sidecar.ts          — unchanged
  paper-generator.ts  — NEW
  paper-modal.ts      — NEW
```

---

## Build & Test

```bash
cd ~/Dev/existing/obsidian-score-annotator
npm install
npm run build
```

Reload plugin in Obsidian: Settings → Community Plugins → disable/re-enable ScoreAnnotator.

**Manual test sequence:**

1. **New paper canvas — staff:**
   - Run command "New paper canvas" → modal → choose Staff, 12 staves, name "Test Staff"
   - `Test Staff.pdf` appears in vault, opens in Obsidian PDF viewer
   - Staff lines visible, toolbar shows Pen/Highlighter/Eraser + 5 swatches + Add Page + Save

2. **Pen tool:**
   - Click Pen → draw a stroke → thin, opaque, uses active swatch color ✓
   - Change width slider → stroke width updates ✓
   - Change opacity slider → opacity updates ✓

3. **Highlighter tool:**
   - Click Highlighter → draw a stroke → wide, 50% opacity ✓
   - Width/opacity sliders now reflect highlighter settings ✓
   - Switch back to Pen → sliders revert to pen settings ✓

4. **Color swatches:**
   - Click swatch 2 → becomes active (highlighted border) ✓
   - Change swatch 2 color via color picker ✓
   - Draw stroke → uses new swatch 2 color ✓
   - Click swatch 1 → active switches back ✓

5. **Add Page:**
   - Click "Add Page" → PDF gains a second page with identical staff layout ✓
   - Draw on page 2 ✓
   - Save → both pages' strokes baked into PDF ✓

6. **Add Page — not shown on regular PDFs:**
   - Open any non-generated PDF → toolbar has NO "Add Page" button ✓

7. **Save & reload:**
   - Draw strokes on both pages → Cmd+S → close PDF → reopen
   - Strokes present on both pages ✓

8. **Regression — existing PDF annotation:**
   - Open an existing annotated PDF → overlay appears → can draw → save works ✓
   - No visual difference in toolbar except new swatches and pen/highlighter split ✓

---

## Known Constraints & Notes

- **pdf-lib already installed** — no new dependencies
- **No undo/redo** — consistent with existing behavior
- **Session-only persistence** for tool settings (colors, width, opacity) — not saved
  to plugin settings, reset on Obsidian restart
- **"Add Page" only for generated PDFs** — detected via PDF subject metadata field
- **stavesPerPage is configurable in modal** but 12 is the default matching the
  reference layout — the math above assumes 12; for other values, recalculate
  `staffTopY = topMargin + i * (staffSpan + gap)` keeping the same margins and
  spacing, adjusting gap to fit
- **Highlighter renders identically to pen** — same canvas API calls, just different
  default width (12) and opacity (0.5); no special blending mode needed
