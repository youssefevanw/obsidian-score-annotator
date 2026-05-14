# Pawgrammer Session Summary

*Session created: 2026-05-10*
*Project: ScoreAnnotater (Obsidian plugin)*

---

## Feature: Plugin scaffold, canvas overlay, and pointer capture

### What Was Built

The first slice of an Obsidian plugin that lets you draw freehand on PDFs you open in your vault. This pass set up the project skeleton, confirmed the PDF-writing library (pdf-lib) bundles into an Obsidian plugin cleanly, and built the drawing surface plus a small toolbar. Saving strokes into the PDF file itself is the next pass.

- **Plugin scaffold**: standard Obsidian plugin layout (`manifest.json`, `main.ts`, esbuild + TypeScript config). Produces a `main.js` that Obsidian can load as a plugin.
- **pdf-lib bundling confirmed**: `pdf-lib` is imported at plugin load time and the production build succeeds with a 428 KB bundle. This proves the chosen save mechanism works in the Obsidian environment before we wire it up.
- **Transparent canvas overlay**: when you open a PDF, a transparent canvas is attached on top of each visible page. It passes clicks through when annotation mode is off, and captures them when it is on.
- **Pointer input**: mouse, stylus, and touch all go through the same Pointer Events code path, so an Apple Pencil or Wacom stylus draws the same way a mouse does.
- **Toolbar**: a small floating toolbar in the upper-right of the PDF pane with an Annotate toggle, Pen, Eraser, color picker, and stroke width slider.
- **Stroke-level eraser**: the eraser removes whole strokes it touches (vector erase), rather than painting white over them. This is the right model for writing strokes back into the PDF later — erased strokes simply won't be saved.
- **DPI-aware rendering**: the canvas resolution scales to the screen's pixel density, so strokes look crisp on Retina displays.

### How to Test This Feature

**Manual load steps (substitute for the playwright e2e flow, since this is an Obsidian plugin and can't run in a regular browser):**

1. **Build the plugin**
   - Open a terminal in `/Users/srpeterjoseph/Desktop/ScoreAnnotater`
   - Run: `npm install` (already done — only re-run if `node_modules` is missing)
   - Run: `npm run build`
   - You should see no errors and a `main.js` file appear in the project root.

2. **Install into a test vault**
   - In your Obsidian vault, open the folder: `<your-vault>/.obsidian/plugins/`
   - Create a new folder called `score-annotator`
   - Copy these three files into it: `main.js`, `manifest.json`, `styles.css`
   - In Obsidian, go to Settings → Community Plugins → enable "ScoreAnnotator"

3. **Open a PDF and try the toolbar**
   - Open any PDF file in your vault
   - You should see a small toolbar in the top-right of the PDF pane with buttons: **Annotate**, **Pen**, **Eraser**, a color square, and a width slider.
   - Click **Annotate** — its label becomes "Annotating" and the button turns the Obsidian accent color.

4. **Draw a stroke**
   - With Annotate on, click and drag across the PDF page
   - You should see a red stroke appear under your cursor
   - Pick a different color from the color square and draw another stroke — it should appear in the new color
   - Move the width slider all the way right and draw — strokes should be visibly thicker

5. **Erase a stroke**
   - Click **Eraser**
   - Click and drag over an existing stroke — the whole stroke disappears as soon as the eraser touches it

6. **Verify pass-through when annotation mode is off**
   - Click **Annotate** again to turn it off (label returns to "Annotate")
   - You should now be able to scroll the PDF and select text normally, as if the plugin weren't there
   - Existing strokes you already drew stay visible underneath

**Known limitations at this milestone (intentional — coming in next passes):**
- Strokes only live in memory. Closing the PDF or reloading Obsidian loses them.
- Ctrl/Cmd+S does not yet write strokes into the PDF file. The Save command is the next milestone.
- No autosave JSON sidecar yet.

### Technical Details

- Files added:
  - `manifest.json`, `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `versions.json`, `.gitignore`
  - `main.ts` — plugin entry, registers leaf observers and the toggle command
  - `src/overlay.ts` — per-page canvas attachment, pointer capture, stroke buffer, redraw
  - `src/toolbar.ts` — floating toolbar UI
  - `src/types.ts` — `Stroke`, `Point`, `PageStrokes` types
  - `styles.css` — overlay and toolbar styles
- Dependencies: `pdf-lib@^1.17.1` (runtime), `esbuild`, `typescript`, `obsidian`, `builtin-modules` (dev)
- Build output: `main.js` (428 KB, includes pdf-lib)

### Architectural Decisions Locked In

1. **Stroke storage in PDF**: content stream drawing (baked into page content). Trade-off: universal viewer compatibility including forScore, at the cost of post-save edit/remove.
2. **Save destination**: in-place overwrite of the original PDF, with a one-time `.bak` on first save.
3. **Unsaved strokes**: autosave JSON sidecar next to the PDF, restored on reopen. PDF itself only touched on explicit save (Ctrl/Cmd+S).
4. **Verification protocol**: build success + manual load instructions, since Obsidian plugins can't be exercised via playwright.

---

## Feature: PDF write-back, autosave sidecar, opacity slider

### What Was Built

The plugin now actually saves your annotations into the PDF file itself, so they show up in any PDF reader — Preview, Acrobat, forScore, etc. Strokes are baked into the PDF's drawing instructions, not stored as a separate file. If you draw something and forget to save, your work is preserved in an autosave file next to the PDF and restored automatically when you reopen it. An opacity slider was also added so you can do highlighter-style marks.

- **Save into the PDF**: hit Cmd/Ctrl+S or click the new **Save** button. The plugin reads the PDF, paints each of your strokes into the page using pdf-lib, and writes the modified PDF back over the original. The annotations are permanent and visible everywhere.
- **First-save backup**: the first time you save a given PDF, the original is copied to `<filename>.pdf.bak` in the same folder. Subsequent saves don't touch the backup, so you always have the un-annotated original.
- **Autosave to a sidecar file**: every time you finish a stroke, the plugin writes a small JSON file (`<filename>.pdf.scoreannotator.json`) next to the PDF after a half-second pause. This file is the safety net for "I drew something but didn't save."
- **Restore on reopen**: when you open a PDF that has a sidecar file, the plugin loads the in-progress strokes back onto the page. You can keep working or save them.
- **Sidecar cleared after save**: once strokes are baked into the PDF, the sidecar is deleted automatically.
- **Rotated PDFs work**: pages with /Rotate 90, 180, or 270 (common in music scans) are handled — strokes land in the correct place when viewed in any PDF reader, regardless of how the page is rotated.
- **Opacity slider**: a second range slider next to the width slider. Drag left for translucent/highlighter strokes, right for fully opaque. Opacity is captured per-stroke at the moment you start drawing.

### How to Test This Feature

1. **Rebuild and reload the plugin**
   - Run `npm run build` in the project folder
   - Copy the updated `main.js`, `manifest.json`, `styles.css` into your vault's plugin folder (or rely on your symlink)
   - In Obsidian, toggle the plugin off and back on (Settings → Community Plugins)

2. **Verify the new toolbar buttons**
   - Open a PDF
   - You should see in the top-right: **Annotate**, **Pen**, **Eraser**, color square, width slider, opacity slider, and a new **Save** button on the far right.

3. **Draw and save**
   - Click **Annotate** to turn on annotation mode
   - Draw a stroke or two
   - Press **Cmd+S** (Mac) or **Ctrl+S** (Win/Linux) — or click **Save**
   - **You should see**: a brief Obsidian notice that says "Annotations saved"
   - **You should also see**: in your vault file list, two new files next to the PDF — one ending in `.pdf.bak` (the original) and the strokes should now be on the page even after closing and reopening the PDF.

4. **Verify the annotation is in the PDF itself**
   - Open the saved PDF in macOS Preview (or any other PDF reader)
   - The strokes should appear on the page exactly where you drew them.
   - Open the same PDF on an iPad in forScore or Adobe — strokes should appear there too.

5. **Test autosave / restore**
   - Open another PDF (or the same one again)
   - Turn on annotation mode and draw a stroke — **do not save**
   - Wait 1 second
   - **You should see**: a new file `<filename>.pdf.scoreannotator.json` appear in the vault next to the PDF.
   - Close the PDF tab in Obsidian.
   - Reopen the PDF.
   - **You should see**: your stroke is back on the page.
   - Now save (Cmd+S). **You should see**: the `.scoreannotator.json` file disappears (it's been baked into the PDF).

6. **Test on a rotated PDF**
   - If you have a music score with rotated pages (or any rotated PDF), open it
   - Draw a stroke on one of the rotated pages
   - Save and reopen in Preview
   - **You should see**: the stroke is in the same visual position as when you drew it in Obsidian (the rotation math is handling the coordinate flip)

7. **Test opacity**
   - With annotation mode on, drag the right-most slider (opacity) to about halfway
   - Draw a stroke — it should be visibly translucent
   - Drag opacity back to full, draw another stroke — fully opaque
   - Save; reopen in Preview — both strokes should be at the opacities you set.

### Technical Details
- New files: `src/pdf-writer.ts`, `src/sidecar.ts`
- Updated files: `src/overlay.ts` (save flow, autosave debounce, sidecar restore, normalized stroke coords, Cmd+S keydown), `src/toolbar.ts` (Save button + opacity slider), `src/types.ts` (normalized point coords), `main.ts` (save-annotations command)
- Stroke coordinate model: normalized 0..1 per page (so zooming the PDF doesn't distort strokes)
- pdf-lib write strategy: content stream `drawLine` per segment with `LineCapStyle.Round`, opacity via graphics state
- Rotation math: `normalizedToNative()` applies inverse-rotation around page center for /Rotate 0/90/180/270
- Stroke width unit: PDF points (1pt = 1/72 inch) — also used directly as CSS pixels in the overlay render
- Save guard: re-entrant `save()` calls are blocked while a save is in flight

---

## How to Run This Project

**This is an Obsidian plugin, not a standalone application.** It runs inside Obsidian against a PDF in your vault.

1. **Build it**
   - Project folder: `/Users/srpeterjoseph/Desktop/ScoreAnnotater`
   - Run `npm run build` to produce `main.js`

2. **Load it into Obsidian**
   - Copy `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/score-annotator/`
   - Enable the plugin in Settings → Community Plugins

3. **Use it**
   - Open any PDF in your vault
   - Click the **Annotate** button in the top-right toolbar to start drawing

**Troubleshooting:**
- **Toolbar doesn't appear**: confirm the plugin is enabled, then close and reopen the PDF tab.
- **Build errors about missing modules**: run `npm install` from the project root.
- **Strokes don't show up**: make sure annotation mode is on (button label says "Annotating").

---

## Session Summary

- **Total features built**: 2 (scaffold + drawing surface; PDF write-back + autosave + opacity)
- **Total files created**: 13 (added `src/pdf-writer.ts`, `src/sidecar.ts`)
- **New dependencies**: pdf-lib, esbuild, typescript, obsidian (types), builtin-modules
- **Estimated time to test**: 10 minutes (rebuild + draw + save + verify in Preview + autosave restore)
- **Next milestone**: stretch goals (e.g., undo/redo, page-relative stroke width, password-protected PDF handling, ink-annotation alternative mode)
