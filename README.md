# ScoreAnnotator

Obsidian plugin for freehand annotation on PDFs, built for marking up music scores. Works on any PDF.

Strokes are saved into the PDF as standard **InkAnnotations** (via [pdf-lib](https://pdf-lib.js.org)), so they display in any PDF reader — Preview, Acrobat, forScore — and remain **editable and erasable** inside Obsidian, even across sessions.

## Features

**Ink**
- Pressure-sensitive pen with smoothed, variable-width strokes ([perfect-freehand](https://github.com/steveruizok/perfect-freehand)) — handwriting from a Wacom or other stylus looks like handwriting
- Full tablet sample rate via coalesced pointer events
- Uniform-width highlighter with adjustable opacity
- 5 pen sizes down to a 0.5pt hairline; 3 highlighter sizes
- 6 customizable color slots

**Erasing**
- Segment eraser: removes only the part of a stroke it touches, splitting the rest into surviving fragments
- Works on fresh strokes *and* strokes saved in previous sessions (the PDF is rewritten without them)
- Three eraser sizes, independent of pen width
- Temporary eraser while holding `X` — releases back to your ink tool as soon as you let go

**Workflow**
- Stylus always draws — no mode toggle needed. The Pan/Draw toggle only affects mouse and touch input
- Undo / redo (`Cmd+Z` / `Cmd+Shift+Z`), including erases and erases of previously saved strokes
- Autosaves unsaved work to a JSON sidecar; restores on reopen
- One-time `.bak` of the original PDF on first save
- Blank paper canvases (staff paper and more) generated in-vault, with an **Add Page** button to append matching pages
- Coexists with PDF++

## Keyboard shortcuts

| Key | Action |
|---|---|
| `B` | Pen |
| `H` | Highlighter |
| `1`–`6` | Color slot 1–6 |
| `Q` `W` `E` `R` `T` | Size preset 1–5 for the active tool (highlighter and eraser use `Q`–`E`) |
| hold `X` | Temporary eraser (releases back to your ink tool) |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `Cmd/Ctrl+S` | Save annotations into the PDF |

Color slots: single-click to select, double-click (or long-press) to edit the color.

## Stylus support

Pointer Events API — Wacom tablets, Apple Pencil, and other styluses work without configuration. Pen input draws immediately, whether or not draw mode is on; palm touches are ignored while the pen is down.

The plugin doesn't read a stylus's physical eraser end as a separate input — the temporary eraser is triggered by holding `X`. If your tablet software supports mapping a pen button or an ExpressKey to a keystroke, mapping one to `X` gives you a press-and-hold hardware eraser.

## Install

Not yet in the Community Plugins browser. Manual install:

1. `git clone` this repo (or download a zip)
2. `npm install && npm run build`
3. Copy `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/score-annotator/`
4. In Obsidian: Settings → Community Plugins → enable **ScoreAnnotator**

For development, symlink the repo into your vault so each `npm run build` goes live:

```sh
ln -s "$(pwd)" "<your-vault>/.obsidian/plugins/score-annotator"
```

## Usage

1. Open a PDF. The floating toolbar appears in the top-right of the pane.
2. Write with a stylus immediately, or click the Pan/Draw toggle to draw with a mouse.
3. Pick tool, color, and size — by toolbar or keyboard.
4. Erase by selecting the eraser tool or holding `X`. Erasing a previously saved stroke rewrites the PDF (you'll see a "PDF updated" notice).
5. `Cmd/Ctrl+S` or the Save button bakes current strokes into the PDF.

**Paper canvases:** run the command **ScoreAnnotator: New paper canvas** to generate a blank staff-paper PDF in your vault. Generated PDFs get an extra **Add Page** toolbar button that appends a page with the same layout.

## Files written next to the PDF

- `<filename>.pdf.bak` — created on your first save; the original unannotated PDF. Never touched again.
- `<filename>.pdf.scoreannotator.json` — autosave sidecar for unsaved strokes. Written ~500ms after each stroke, deleted after a successful save.

## How annotations are stored

Each stroke is a PDF **InkAnnotation**:

- `/InkList` holds the stroke's centerline points (standard, readable by any PDF tool)
- `/SAPress` (custom key) holds per-point pressure; `/SAKind` distinguishes pen from highlighter
- The appearance stream (`/AP /N`) contains the rendered ink — a filled variable-width outline for pressure strokes, a stroked polyline for highlighter — so external viewers show exactly what you drew
- Each annotation carries a marker key (`/SAv`) and `/T` set to `ScoreAnnotator`, so the plugin can find, strip, and rewrite only its own ink idempotently on every save; strokes from other tools are never touched

Because strokes are annotations rather than page content, the plugin can read them back on reopen and let you erase them later. Rotated pages (`/Rotate` 90/180/270) are handled in both directions.

## Known limitations

- Settings (colors, sizes) are per-session, not persisted
- No lasso/select or move of existing strokes
- One annotating view per PDF at a time behaves best

## License

MIT
