# ScoreAnnotator — Paper Canvas Feature
## Handoff Document
*Generated May 15, 2026*

---

## Goal

Add a "New Paper Canvas" mode to the existing `obsidian-score-annotator` plugin. The user can open a new canvas with a chosen paper template (staff, blank, dot grid, graph paper), draw on it freehand with the existing pen/eraser tools, and export it to PDF for personal use.

The existing PDF annotation workflow (open a PDF → overlay strokes → save baked into PDF) must remain **completely unchanged**.

---

## Repo

`https://github.com/youssefevanw/obsidian-score-annotator`

Local path (user's machine): `~/Dev/existing/obsidian-score-annotator/`

---

## Current Architecture (do not break)

```
main.ts                  — plugin entry; attaches OverlayController to pdf-type leaves
src/
  overlay.ts             — OverlayController: canvas overlay on Obsidian's PDF viewer
  toolbar.ts             — Toolbar UI (pen, eraser, color, width, opacity, save)
  pdf-reader.ts          — reads InkAnnotations from PDF bytes → PageStrokes[]
  pdf-writer.ts          — writes PageStrokes[] → baked PDF bytes via pdf-lib
  sidecar.ts             — autosave JSON sidecar next to PDF file
  types.ts               — Tool, Point, Stroke, PageStrokes
```

**How the existing flow works:**
1. `main.ts` watches for `pdf`-type leaves via workspace events
2. For each PDF leaf, it creates an `OverlayController` and calls `attach()`
3. `OverlayController` injects a `<canvas>` overlay on top of each `.page` element rendered by Obsidian's PDF viewer
4. Strokes are stored normalized (0..1 relative to page rect) in `allStrokes: Map<pageIndex, Stroke[]>`
5. Save calls `pdf-writer.ts` which bakes strokes as InkAnnotations into the PDF file in the vault
6. Autosave writes a `.scoreannotator.json` sidecar every 500ms after a stroke

**Key design decisions already in place:**
- Strokes use normalized [0..1] coordinates — independent of display size
- `paintStroke()` in `overlay.ts` is the canvas draw function; it maps normalized → CSS pixels
- `Toolbar` is a plain DOM class that takes option callbacks — it's already reusable
- pdf-lib is already a dependency

---

## What to Build

### 1. New file: `src/paper-generator.ts`

Generates paper template as canvas draw calls. Four templates:

```typescript
export type PaperTemplate = "blank" | "staff" | "dot-grid" | "graph";

export interface PaperOptions {
  template: PaperTemplate;
  // Staff-specific (all other templates ignore these)
  stavesPerPage?: number;   // default 12
}

export function drawPaperTemplate(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: PaperOptions
): void
```

Implementation notes:
- **blank**: draw nothing (white/transparent)
- **dot-grid**: dots every 20px, radius 1px, color `#cccccc`
- **graph**: grid lines every 20px, color `#dddddd`, 0.5px
- **staff**: see exact layout spec below

**Staff template — exact layout (reverse-engineered from reference PDF):**

The reference is US Letter (612 × 792 pts), 12 staves per page, single staves (not systems).

Measurements in PDF points (1pt = 1/72 inch):
- Page: 612 × 792 pts (US Letter)
- Left margin: 54.25 pts
- Right margin: 54.25 pts (symmetric)
- Top margin (first staff top line): 65.05 pts
- Bottom margin (last staff bottom line to page bottom): 65.05 pts
- Staves per page: 12
- Lines per staff: 5
- Line spacing within staff: 7.07 pts (between adjacent lines)
- Staff span (top to bottom line): 28.30 pts
- Gap between staves (bottom line of staff N to top line of staff N+1): 29.30 pts
- Line stroke width: 0.5 pts
- Line color: `#000000` (black, matching reference)

**How to draw on canvas (scale from PDF points to canvas pixels):**

```
scaleX = canvasWidth / 612
scaleY = canvasHeight / 792

For each staff i (0-indexed, 0..11):
  staffTopY = 65.05 + i * (28.30 + 29.30)   // = 65.05 + i * 57.60
  For each line j (0..4):
    y = staffTopY + j * 7.07
    draw horizontal line from (54.25 * scaleX, y * scaleY) to ((612 - 54.25) * scaleX, y * scaleY)
    lineWidth = 0.5 * scaleX  // scale with page width
```

Line color on canvas: `#000000`, globalAlpha = 1.

**For PDF export (in `paper-exporter.ts`):** Use the raw pt values above directly — no scaling needed since pdf-lib works in PDF points. Note pdf-lib's y-axis is bottom-up, so convert: `pdfY = 792 - y`.

### 2. New file: `src/paper-canvas-view.ts`

A new Obsidian `ItemView` that renders a paper canvas. This is the core new view.

```typescript
export const PAPER_CANVAS_VIEW_TYPE = "score-annotator-paper-canvas";

export class PaperCanvasView extends ItemView {
  // paper template and options stored in view state
  // single canvas (not multi-page like overlay.ts)
  // reuses Toolbar from toolbar.ts
  // reuses paintStroke() logic from overlay.ts (extract to shared util or duplicate — see note below)
  // allStrokes: Stroke[] (single page, no pageIndex needed)
  // autosave: writes to a .scoreannotator.json sidecar next to the .canvas file
}
```

**View state** (persisted by Obsidian via `getState`/`setState`):
```typescript
{
  template: PaperTemplate,
  options: PaperOptions,
  filePath: string   // path to the .sacanvas file in the vault
}
```

**File format:** Create a new vault file with extension `.sacanvas` (plain JSON):
```json
{
  "version": 1,
  "template": "staff",
  "options": { "systemsPerPage": 6, "stavesPerSystem": 1 },
  "strokes": [ ...Stroke[] ]
}
```

**Save (Cmd+S):** writes strokes back into the `.sacanvas` JSON file. No PDF baking on save — strokes live in the JSON.

**Export to PDF:** separate button in toolbar labeled "Export PDF". Calls `src/paper-exporter.ts` (see below).

**Canvas sizing:** use US Letter proportions (width:height = 612:792 = 1:1.2941) at a fixed resolution (e.g. 816×1056px at 96dpi — 612pts × 96/72). Apply `devicePixelRatio` scaling as `overlay.ts` does.

**Pointer events:** copy the `onPointerDown / onPointerMove / onPointerUp` logic from `overlay.ts` directly. It's straightforward enough that duplication is fine here; don't over-engineer a shared base class.

### 3. New file: `src/paper-exporter.ts`

Exports the paper canvas (template + strokes) to a PDF file in the vault.

```typescript
export async function exportPaperCanvasToPdf(
  app: App,
  strokes: Stroke[],
  opts: PaperOptions,
  outputPath: string   // suggested path, e.g. same folder as .sacanvas file
): Promise<void>
```

Implementation:
1. Create a new `PDFDocument` via pdf-lib (don't load an existing PDF)
2. Add a single A4 page (`PDFDocument.addPage([595.28, 841.89])` — standard A4 in points)
3. Draw the paper template using pdf-lib draw primitives (lines for staff/graph, dots for dot-grid)
4. Bake strokes using the existing `normalizedToNative()` from `pdf-writer.ts` and the same appearance stream logic from `buildInkAppearance()` — reuse those functions directly
5. Save to vault at `outputPath` (prompt user if file already exists)

**PDF page size:** US Letter — `PDFDocument.addPage([612, 792])`

**Staff drawing in PDF points (for step 3):**
- Use the exact measurements from the Staff layout spec above
- pdf-lib y-axis is bottom-up: convert with `pdfY = 792 - y` for each staff line y value

### 4. New file: `src/paper-modal.ts`

A simple Obsidian `Modal` for choosing template options before creating a new canvas.

```typescript
export class NewPaperCanvasModal extends Modal {
  // Dropdown: blank / staff / dot-grid / graph
  // If staff: number input for stavesPerPage (default 12)
  // Text input: file name (default "Untitled Canvas")
  // Folder picker or default to vault root
  // OK button → calls callback(template, options, fileName, folderPath)
}
```

### 5. Modify `main.ts`

Add:
1. Register the `PaperCanvasView` view type
2. Register the `.sacanvas` file extension to open with `PaperCanvasView`
3. Add a command: `"New paper canvas"` → opens `NewPaperCanvasModal` → creates `.sacanvas` file → opens in `PaperCanvasView`
4. Add a command: `"Open paper canvas"` → file picker filtered to `.sacanvas`

### 6. Modify `toolbar.ts`

Add an optional `onExport` callback to `ToolbarOpts`:
```typescript
onExport?: () => void;
```
If provided, render an "Export PDF" button in the toolbar. The existing Save button behavior is unchanged.

---

## What NOT to Change

- `overlay.ts` — zero modifications
- `pdf-reader.ts` — zero modifications
- `pdf-writer.ts` — zero modifications (but `normalizedToNative` and `buildInkAppearance` will be imported by `paper-exporter.ts`)
- `sidecar.ts` — zero modifications
- `types.ts` — zero modifications (all new types go in `paper-canvas-view.ts` or `paper-generator.ts`)

---

## File Structure After Changes

```
main.ts                        — modified (register view, commands)
src/
  overlay.ts                   — unchanged
  toolbar.ts                   — modified (optional onExport callback)
  pdf-reader.ts                — unchanged
  pdf-writer.ts                — unchanged (functions reused by paper-exporter)
  sidecar.ts                   — unchanged
  types.ts                     — unchanged
  paper-generator.ts           — NEW
  paper-canvas-view.ts         — NEW
  paper-exporter.ts            — NEW
  paper-modal.ts               — NEW
```

---

## Build & Test

```bash
cd ~/Dev/existing/obsidian-score-annotator
npm install
npm run build
```

Symlink for live dev (if not already set up):
```bash
ln -s "$(pwd)" "<vault-path>/.obsidian/plugins/score-annotator"
```

Then in Obsidian: Settings → Community Plugins → disable/re-enable ScoreAnnotator to reload.

**Manual test sequence:**
1. Run command "New paper canvas" → modal appears → choose "staff" → confirm
2. `.sacanvas` file created in vault, `PaperCanvasView` opens
3. Staff lines visible on canvas
4. Draw strokes with pen tool
5. Cmd+S → strokes persisted in `.sacanvas` JSON
6. Close and reopen the `.sacanvas` file → strokes restore
7. Click "Export PDF" → PDF appears in vault → open in Preview → staff lines and strokes visible
8. Open an existing PDF → existing annotation toolbar appears, annotation works as before (regression check)

---

## Known Constraints & Notes

- **pdf-lib is already installed** — no new dependencies needed for the exporter
- **No undo/redo** — consistent with existing overlay behavior; eraser is the only removal tool
- **Single page only** for paper canvas v1 — multi-page is a future feature
- **`.sacanvas` extension** is arbitrary but distinctive; avoids conflicts with Obsidian's `.canvas` (Obsidian Canvas format)
- **Export path:** default to same folder as the `.sacanvas` file, same base name, `.pdf` extension. If that file exists, append a timestamp.
- The paper template is **redrawn from scratch on every resize** — don't cache it, just call `drawPaperTemplate()` again in the ResizeObserver callback
- **Toolbar positioning:** paper canvas view owns its own container element, so no 96px offset needed (that offset in `styles.css` is only for the PDF overlay toolbar)
