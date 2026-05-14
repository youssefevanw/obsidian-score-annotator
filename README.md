# ScoreAnnotator

Obsidian plugin for freehand annotation on PDFs. Strokes are written permanently into the PDF file using [pdf-lib](https://pdf-lib.js.org), so they show up in any PDF reader — Preview, Acrobat, forScore, etc.

Built for marking up music scores. Works on any PDF.

## Status

v0.1 — early. Functional but minimal. See [Known limitations](#known-limitations).

## Features

- Pen tool with color, width, and opacity
- Stroke-level eraser (removes whole strokes on touch — clean vector erase)
- Annotations baked into each page's content stream (universal viewer support)
- Handles rotated pages (`/Rotate 0 / 90 / 180 / 270`)
- Autosaves unsaved work to a JSON sidecar; restores on reopen
- One-time `.bak` of the original PDF on first save
- Mouse, stylus (incl. Apple Pencil), and touch via the Pointer Events API
- Coexists with PDF++ (doesn't fight for Cmd/Ctrl+S; toolbar offset below)

## Install

Not yet in the Community Plugins browser. Manual install:

1. `git clone` this repo (or download a zip)
2. `npm install && npm run build`
3. Copy `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/score-annotator/`
4. In Obsidian: Settings → Community Plugins → enable **ScoreAnnotator**

For development, symlink the build output directly into your vault so each `npm run build` goes live:

```sh
ln -s "$(pwd)" "<your-vault>/.obsidian/plugins/score-annotator"
```

## Usage

1. Open a PDF in Obsidian. A floating toolbar appears in the top-right of the pane.
2. Click **Annotate** to enter drawing mode. The cursor turns into a crosshair and the canvas captures pointer input.
3. Pick your color, width, and opacity. Draw on the page.
4. Switch to **Eraser** to remove whole strokes by touching them.
5. Press **Cmd/Ctrl+S** or click **Save** to bake the strokes into the PDF.

Outside annotation mode, the overlay passes pointer input through to Obsidian — you can scroll and select text normally. Existing unsaved strokes stay visible underneath.

## Files written next to the PDF

- `<filename>.pdf.bak` — created on your first save; contains the original unannotated PDF. Subsequent saves don't touch it.
- `<filename>.pdf.scoreannotator.json` — autosave sidecar for unsaved strokes. Written ~500ms after each stroke completes, deleted after a successful save.

## How annotations are stored in the PDF

Strokes go directly into each page's content stream as a sequence of stroked line segments (pdf-lib's `drawLine` with `LineCapStyle.Round`; opacity via ExtGState). That means:

- **Universal viewer support** — strokes are page content, not annotations, so every PDF reader displays them
- **Not editable as discrete objects** after saving — they're part of the page
- **The `.bak` is the safety net** if you want to revert

Coordinate mapping handles `/Rotate` by inverting the rotation around the page center, so strokes drawn on a rotated page land in the correct visual position in any reader.

## Coexistence with PDF++

- The toolbar sits 96px from the top of the PDF pane so it doesn't overlap PDF++'s toolbar.
- Cmd/Ctrl+S is only claimed when annotation mode is on **or** there are unsaved strokes. Otherwise it passes through.
- The plugin doesn't register a PDF view type — it layers on top of whichever viewer is rendering the PDF.

## Known limitations

- **No undo/redo.** The eraser is the only way to remove a stroke before saving.
- **Strokes briefly disappear after save** until the PDF view re-renders from disk.
- **Password-protected/encrypted PDFs are not supported** — pdf-lib limitation; save fails with "see console."
- **Renaming or moving a PDF in the vault** doesn't move its sidecar JSON. Save first, then rename.
- **Stroke width is in PDF points** (1 pt = 1/72 inch); on-screen rendering uses the same number as CSS pixels, so visual thickness vs. saved thickness can drift at non-100% zoom.
- **Pressure sensitivity is not used** even when reported by the stylus.

## Build from source

```sh
npm install
npm run build    # production build → main.js
npm run dev      # esbuild watch mode
```

Requires Node 18+.

## License

TBD.
