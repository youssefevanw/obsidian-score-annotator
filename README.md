# ScoreAnnotator

Obsidian plugin for freehand annotation on PDFs. Strokes are written as standard **InkAnnotations** (PDF spec §12.5.6.13) using [pdf-lib](https://pdf-lib.js.org), so they display in any PDF reader — Preview, Acrobat, forScore, etc. — and can be erased and redrawn after saving.

Built for marking up music scores. Works on any PDF.

## Status

v0.2 — functional. See [Known limitations](#known-limitations).

## Features

- **Pen tool** — pressure-sensitive strokes via [perfect-freehand](https://github.com/steveruizok/perfect-freehand). Line weight follows Wacom/Apple Pencil pressure; mouse draws uniform-width strokes. Hairline pen available (0.5 pt).
- **Highlighter tool** — uniform semi-transparent strokes (marker look; no pressure thinning).
- **Eraser** — removes whole strokes by touch. One erase gesture = one undo step.
- **Undo / Redo** — Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z. Baked strokes that are undone-and-erased retrigger the PDF rewrite automatically.
- **5 color swatches** with color picker. Swatches persist for the session.
- **Width dots** — per-tool stroke width presets shown as filled circles at actual stroke size.
  - Pen: 0.5 / 1 / 2 / 3.5 / 6 pt
  - Highlighter: 6 / 12 / 20 pt
- **Opacity chips** — highlighter-only; 25 / 50 / 75% rendered in the active color.
- **Stylus-always-on** — Wacom / Apple Pencil draws without toggling annotation mode; trackpad and touch scroll still work. Palm rejection: touch is ignored while a pen stroke is in progress.
- **Paper canvas** — create blank, staff-paper, dot-grid, or graph-paper PDFs from the command palette. Add Page button appends a new page with the same layout.
- Handles rotated pages (0 / 90 / 180 / 270°).
- Autosaves unsaved work to a JSON sidecar; restores on reopen.
- One-time `.bak` of the original PDF on first save.
- Coexists with PDF++ (Cmd/Ctrl+S only claimed when needed; toolbar offset below PDF++ toolbar).

## Install

Not yet in the Community Plugins browser. Manual install:

1. `git clone` this repo (or download a zip)
2. `npm install && npm run build`
3. Copy `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/score-annotator/`
4. In Obsidian: Settings → Community Plugins → enable **ScoreAnnotator**

For development, symlink the build output directly into your vault:

```sh
ln -s "$(pwd)" "<your-vault>/.obsidian/plugins/score-annotator"
```

## Usage

1. Open a PDF in Obsidian. A floating toolbar appears at the top-right of the pane.
2. Pick **Pen**, **Highlighter**, or **Eraser** from the toolbar.
3. Stylus users: touch the page — annotation mode activates automatically for pen input. Mouse/touch users: click **Annotate** first.
4. Select a color swatch, width dot, and (highlighter) opacity chip.
5. Draw on the page. Pressure from Wacom and Apple Pencil varies the line weight.
6. Press **Cmd/Ctrl+Z** to undo, **Cmd/Ctrl+Shift+Z** to redo.
7. Press **Cmd/Ctrl+S** or click **Save** to bake strokes into the PDF as InkAnnotations.

Outside annotation mode, the overlay passes pointer input through to Obsidian — you can scroll and select text normally.

### Erasing a baked stroke

When you erase a stroke that was already saved in the PDF, the plugin rewrites the PDF in the background (≈ 800 ms debounce). A "PDF updated" notice confirms the write. The stroke is then gone from both the canvas and the PDF. Cmd+Z after an erase restores the stroke; if it was baked, the PDF is rewritten again to include it.

## Files written next to the PDF

- `<filename>.pdf.bak` — created on your first save; contains the original unannotated PDF. Subsequent saves don't touch it.
- `<filename>.pdf.scoreannotator.json` — autosave sidecar for unsaved strokes. Written ~500 ms after each stroke, deleted after a successful save.

## How annotations are stored

Strokes are saved as **InkAnnotations** (not embedded in the page content stream), so:

- **Editable / erasable after saving** — reopen in ScoreAnnotator, erase, redraw, save again.
- **External viewer support** — every annotation has a pre-rendered `/AP /N` appearance stream, so Preview, forScore, Acrobat, and other viewers display the strokes without needing to understand InkAnnotations.
- **Variable-width pen** — the appearance stream uses the perfect-freehand outline polygon (not a stroked polyline), so external viewers see the same pressure-sensitive strokes as the overlay canvas.
- **Highlighter** — stored as stroked-polyline appearance with opacity; looks like a marker in all viewers.
- **Pressure data** — stored in a custom `/SAPress` array on the annotation. Old viewers ignore unknown keys and render the appearance stream normally.

## Coexistence with PDF++

- The toolbar sits 96 px from the top of the PDF pane so it doesn't overlap PDF++'s toolbar.
- Cmd/Ctrl+S is only claimed when annotation mode is on **or** there are unsaved strokes.
- The plugin doesn't register a PDF view type — it layers on top of whichever viewer is rendering the PDF.

## Known limitations

- **Undo across saves is partial** — undoing an `add` action after saving removes the stroke from the overlay but not from the PDF (the baked copy remains). Erase the stroke normally if you need it out of the saved PDF.
- **Password-protected / encrypted PDFs** — pdf-lib limitation; save fails with "see console."
- **Renaming or moving a PDF** doesn't move its sidecar JSON. Save first, then rename.
- **Stroke width vs zoom** — stroke width is in PDF points (1 pt = 1/72 inch); the overlay renders the same number as CSS pixels, so visual thickness vs. saved thickness can drift at non-100% zoom. The appearance stream in the PDF is always correct.

## Build from source

```sh
npm install
npm run build    # production build → main.js
npm run dev      # esbuild watch mode
```

Requires Node 18+.

## License

TBD.
