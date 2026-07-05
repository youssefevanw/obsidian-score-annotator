import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFImage,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { PageStrokes, PlacedImage, Stroke } from "./types";
import { strokeOutlineCoords } from "./ink";

// Marker used to identify InkAnnotations created by this plugin so we can
// strip + rewrite them idempotently on each save. /T also shows up as the
// annotation author in viewers.
export const ANNOT_TAG = "ScoreAnnotator";
export const ANNOT_MARKER_KEY = "SAv";
const ANNOT_VERSION = 1;

export async function writeStrokesIntoPdf(
  bytes: ArrayBuffer,
  pages: PageStrokes[],
  images: PlacedImage[] = [],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(bytes);
  const pdfPages = pdfDoc.getPages();

  const pagesByIndex = new Map<number, Stroke[]>();
  for (const p of pages) pagesByIndex.set(p.pageIndex, p.strokes);
  const imagesByIndex = new Map<number, PlacedImage[]>();
  for (const img of images) {
    const list = imagesByIndex.get(img.pageIndex);
    if (list) list.push(img);
    else imagesByIndex.set(img.pageIndex, [img]);
  }

  // Embedded images are deduplicated by source base64 across the whole
  // document — pasting the same image twice shouldn't double the bytes.
  const embedCache = new Map<string, PDFImage>();

  for (let i = 0; i < pdfPages.length; i++) {
    const pdfPage = pdfPages[i];
    stripOwnAnnotations(pdfPage);
    const strokes = pagesByIndex.get(i);
    if (strokes && strokes.length > 0) addInkAnnotations(pdfDoc, pdfPage, strokes);
    const pageImages = imagesByIndex.get(i);
    if (pageImages && pageImages.length > 0) {
      await addImageAnnotations(pdfDoc, pdfPage, pageImages, embedCache);
    }
  }

  return pdfDoc.save({ useObjectStreams: true });
}

function stripOwnAnnotations(page: PDFPage): void {
  const annots = page.node.Annots();
  if (!annots) return;
  const ctx = page.doc.context;
  const removeIndices: number[] = [];
  const refsToFree: PDFRef[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const entry = annots.get(i);
    const dict = ctx.lookupMaybe(entry, PDFDict);
    if (!dict) continue;
    if (!isOwnInkAnnotation(dict) && !isOwnStampAnnotation(dict)) continue;
    removeIndices.push(i);
    if (entry instanceof PDFRef) refsToFree.push(entry);
  }
  for (let j = removeIndices.length - 1; j >= 0; j--) {
    annots.remove(removeIndices[j]);
  }
  for (const ref of refsToFree) ctx.delete(ref);
}

function isOwnAnnotationOfSubtype(dict: PDFDict, subtype: string): boolean {
  const st = dict.get(PDFName.of("Subtype"));
  if (!(st instanceof PDFName)) return false;
  if (st.decodeText() !== subtype) return false;
  if (dict.has(PDFName.of(ANNOT_MARKER_KEY))) return true;
  const t = dict.get(PDFName.of("T"));
  if (t instanceof PDFString || t instanceof PDFHexString) {
    return t.decodeText() === ANNOT_TAG;
  }
  return false;
}

export function isOwnInkAnnotation(dict: PDFDict): boolean {
  return isOwnAnnotationOfSubtype(dict, "Ink");
}

export function isOwnStampAnnotation(dict: PDFDict): boolean {
  return isOwnAnnotationOfSubtype(dict, "Stamp");
}

function addInkAnnotations(
  pdfDoc: PDFDocument,
  page: PDFPage,
  strokes: Stroke[],
): void {
  const { width, height } = page.getSize();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;

  let annots = page.node.Annots();
  if (!annots) {
    annots = pdfDoc.context.obj([]) as PDFArray;
    page.node.set(PDFName.of("Annots"), annots);
  }

  for (const stroke of strokes) {
    if (stroke.tool !== "pen" || stroke.points.length < 2) continue;
    const color = hexToRgb(stroke.color);
    const native = stroke.points.map((p) =>
      normalizedToNative(p.x, p.y, width, height, rotation),
    );
    // Attach pressure to native points for the appearance stream.
    const nativeWithPressure = native.map((pt, i) => ({
      x: pt.x,
      y: pt.y,
      p: stroke.points[i]?.p,
    }));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const flatPath: number[] = [];
    for (const pt of native) {
      flatPath.push(round2(pt.x), round2(pt.y));
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    const pad = Math.max(stroke.width, 1);
    const rect: [number, number, number, number] = [
      round2(minX - pad),
      round2(minY - pad),
      round2(maxX + pad),
      round2(maxY + pad),
    ];

    const strokeKind = stroke.kind ?? (stroke.opacity < 1 ? "highlighter" : "pen");
    const hasPressure = stroke.points.some((p) => p.p !== undefined && p.p > 0);

    const apRef = strokeKind === "pen"
      ? buildFilledInkAppearance(
          pdfDoc,
          nativeWithPressure,
          rect,
          color,
          stroke.width,
          stroke.opacity,
        )
      : buildStrokedInkAppearance(
          pdfDoc,
          native,
          rect,
          color,
          stroke.width,
          stroke.opacity,
        );

    const annotDict = pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Ink",
      Rect: rect,
      InkList: [flatPath],
      C: [color.r, color.g, color.b],
      CA: stroke.opacity,
      BS: { Type: "Border", W: stroke.width, S: "S" },
      F: 4,
      AP: { N: apRef },
      T: PDFString.of(ANNOT_TAG),
      [ANNOT_MARKER_KEY]: ANNOT_VERSION,
      SAKind: PDFString.of(strokeKind),
    }) as PDFDict;

    if (hasPressure) {
      const pressureArr = pdfDoc.context.obj(
        stroke.points.map((p) => PDFNumber.of(round2(p.p ?? 0.5))),
      ) as PDFArray;
      annotDict.set(PDFName.of("SAPress"), pressureArr);
    }

    annots.push(pdfDoc.context.register(annotDict));
  }
}

async function addImageAnnotations(
  pdfDoc: PDFDocument,
  page: PDFPage,
  images: PlacedImage[],
  embedCache: Map<string, PDFImage>,
): Promise<void> {
  const { width: mediaWidth, height: mediaHeight } = page.getSize();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const rotatedVisual = rotation === 90 || rotation === 270;
  const visualW = rotatedVisual ? mediaHeight : mediaWidth;
  const visualH = rotatedVisual ? mediaWidth : mediaHeight;

  let annots = page.node.Annots();
  if (!annots) {
    annots = pdfDoc.context.obj([]) as PDFArray;
    page.node.set(PDFName.of("Annots"), annots);
  }

  for (const image of images) {
    const embedded = await embedImageDeduped(pdfDoc, embedCache, image);

    // Rotate the image's 4 corners (in visual, screen-like page space: x
    // right, y down, matching the overlay canvas convention used to draw
    // and place it) about its center, then map each corner through the
    // same page-rotation handling normalizedToNative uses. This gives an
    // exact native-space quadrilateral without ever needing to reason
    // about how a rotation angle composes with page /Rotate.
    const halfW = (image.w * visualW) / 2;
    const halfH = (image.h * visualH) / 2;
    const cxVisual = image.cx * visualW;
    const cyVisualScreen = image.cy * visualH;
    const cosR = Math.cos(image.rotation);
    const sinR = Math.sin(image.rotation);
    const cornerNative = (lx: number, ly: number) => {
      const rx = cosR * lx - sinR * ly;
      const ry = sinR * lx + cosR * ly;
      const u = cxVisual + rx;
      const v = visualH - (cyVisualScreen + ry);
      return visualToNative(u, v, mediaWidth, mediaHeight, rotation);
    };
    const topLeft = cornerNative(-halfW, -halfH);
    const topRight = cornerNative(halfW, -halfH);
    const bottomLeft = cornerNative(-halfW, halfH);
    const bottomRight = cornerNative(halfW, halfH);

    const xs = [topLeft.x, topRight.x, bottomLeft.x, bottomRight.x];
    const ys = [topLeft.y, topRight.y, bottomLeft.y, bottomRight.y];
    const rect: [number, number, number, number] = [
      round2(Math.min(...xs)),
      round2(Math.min(...ys)),
      round2(Math.max(...xs)),
      round2(Math.max(...ys)),
    ];

    // Affine matrix mapping the Image XObject's unit square — (0,0)
    // bottom-left, (1,0) bottom-right, (0,1) top-left, per the PDF Image
    // XObject convention — onto the rotated quadrilateral above.
    const a = bottomRight.x - bottomLeft.x;
    const b = bottomRight.y - bottomLeft.y;
    const c = topLeft.x - bottomLeft.x;
    const d = topLeft.y - bottomLeft.y;
    const e = bottomLeft.x;
    const f = bottomLeft.y;
    const ops = [
      "q",
      `${fmtNum(a)} ${fmtNum(b)} ${fmtNum(c)} ${fmtNum(d)} ${fmtNum(e)} ${fmtNum(f)} cm`,
      "/Im0 Do",
      "Q",
    ];
    const contentBytes = new TextEncoder().encode(ops.join("\n"));
    const stream = pdfDoc.context.flateStream(contentBytes, {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: rect,
      Resources: { ProcSet: ["PDF", "ImageC"], XObject: { Im0: embedded.ref } },
    });
    const apRef = pdfDoc.context.register(stream);

    const annotDict = pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Stamp",
      Rect: rect,
      F: 4,
      AP: { N: apRef },
      T: PDFString.of(ANNOT_TAG),
      [ANNOT_MARKER_KEY]: ANNOT_VERSION,
      SAKind: PDFString.of("image"),
      SAId: PDFString.of(image.id),
      SAMime: PDFString.of(image.mime),
      SACx: round2(image.cx),
      SACy: round2(image.cy),
      SAW: round2(image.w),
      SAH: round2(image.h),
      SARot: round2(image.rotation),
      // Duplicated verbatim (rather than re-extracted from the embedded
      // XObject on read) because pdf-lib's PNG embedder decodes to raw
      // Flate-compressed pixel samples plus a separate alpha-channel
      // XObject — reconstructing a standalone PNG from that means writing
      // a PNG encoder ourselves. JPEG embedding *does* keep the source
      // bytes verbatim (DCTDecode), but treating both formats the same
      // way is simpler and more robust than a format-dependent read path.
      // Cost: this roughly doubles the annotation's on-disk size.
      SAData: PDFString.of(image.data),
    }) as PDFDict;

    annots.push(pdfDoc.context.register(annotDict));
  }
}

async function embedImageDeduped(
  pdfDoc: PDFDocument,
  cache: Map<string, PDFImage>,
  image: PlacedImage,
): Promise<PDFImage> {
  const cached = cache.get(image.data);
  if (cached) return cached;
  const bytes = base64ToBytes(image.data);
  const embedded =
    image.mime === "image/jpeg"
      ? await pdfDoc.embedJpg(bytes)
      : await pdfDoc.embedPng(bytes);
  cache.set(image.data, embedded);
  return embedded;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Appearance stream for pen strokes: filled perfect-freehand outline polygon.
// Produces variable-width strokes that match the canvas rendering exactly.
function buildFilledInkAppearance(
  pdfDoc: PDFDocument,
  points: { x: number; y: number; p?: number }[],
  bbox: [number, number, number, number],
  color: { r: number; g: number; b: number },
  width: number,
  opacity: number,
): PDFRef {
  const poly = simplifyOutline(strokeOutlineCoords(points, width), OUTLINE_SIMPLIFY_TOLERANCE);

  const useExtState = opacity < 1;
  const ops: string[] = ["q"];
  if (useExtState) ops.push("/G0 gs");
  ops.push(`${fmtNum(color.r)} ${fmtNum(color.g)} ${fmtNum(color.b)} rg`); // fill color
  if (poly.length >= 3) {
    ops.push(`${fmtNum(poly[0][0])} ${fmtNum(poly[0][1])} m`);
    for (let i = 1; i < poly.length; i++) {
      ops.push(`${fmtNum(poly[i][0])} ${fmtNum(poly[i][1])} l`);
    }
    ops.push("h"); // close
    ops.push("f"); // fill
  }
  ops.push("Q");

  return buildAppearanceStream(pdfDoc, ops, bbox, useExtState, opacity);
}

// Appearance stream for highlighter / legacy strokes: uniform stroked polyline.
function buildStrokedInkAppearance(
  pdfDoc: PDFDocument,
  points: { x: number; y: number }[],
  bbox: [number, number, number, number],
  color: { r: number; g: number; b: number },
  width: number,
  opacity: number,
): PDFRef {
  const useExtState = opacity < 1;
  const ops: string[] = ["q"];
  if (useExtState) ops.push("/G0 gs");
  ops.push(`${fmtNum(color.r)} ${fmtNum(color.g)} ${fmtNum(color.b)} RG`); // stroke color
  ops.push(`${fmtNum(width)} w`);
  ops.push("1 J"); // round caps
  ops.push("1 j"); // round joins
  ops.push(`${fmtNum(points[0].x)} ${fmtNum(points[0].y)} m`);
  for (let i = 1; i < points.length; i++) {
    ops.push(`${fmtNum(points[i].x)} ${fmtNum(points[i].y)} l`);
  }
  ops.push("S");
  ops.push("Q");

  return buildAppearanceStream(pdfDoc, ops, bbox, useExtState, opacity);
}

function buildAppearanceStream(
  pdfDoc: PDFDocument,
  ops: string[],
  bbox: [number, number, number, number],
  useExtState: boolean,
  opacity: number,
): PDFRef {
  const contentBytes = new TextEncoder().encode(ops.join("\n"));
  const resources = useExtState
    ? {
        ProcSet: ["PDF"],
        ExtGState: {
          G0: { Type: "ExtGState", CA: opacity, ca: opacity },
        },
      }
    : { ProcSet: ["PDF"] };

  const stream = pdfDoc.context.flateStream(contentBytes, {
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: bbox,
    Resources: resources,
  });
  return pdfDoc.context.register(stream);
}

// perfect-freehand emits a dense outline (often 2-4 vertices per input
// sample). Vertices this close together are visually indistinguishable in
// the filled path, so drop them before serializing.
const OUTLINE_SIMPLIFY_TOLERANCE = 0.3;

function simplifyOutline(poly: number[][], tolerance: number): number[][] {
  if (poly.length < 3) return poly;
  const minDist2 = tolerance * tolerance;
  const out: number[][] = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const prev = out[out.length - 1];
    const dx = poly[i][0] - prev[0];
    const dy = poly[i][1] - prev[1];
    if (dx * dx + dy * dy >= minDist2) out.push(poly[i]);
  }
  // The path is closed with an explicit `h` operator — drop a final vertex
  // that's already effectively back at the start so `h` doesn't produce a
  // near-zero-length closing edge.
  if (out.length > 2) {
    const first = out[0];
    const last = out[out.length - 1];
    const dx = last[0] - first[0];
    const dy = last[1] - first[1];
    if (dx * dx + dy * dy < minDist2) out.pop();
  }
  return out;
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

// PDF-space coordinates and pressures only need ~2 decimals for sub-visible
// accuracy; full float precision costs ~15 chars per number.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function normalizedToNative(
  nx: number,
  ny: number,
  mediaWidth: number,
  mediaHeight: number,
  rotation: number,
): { x: number; y: number } {
  const rotated = rotation === 90 || rotation === 270;
  const visualW = rotated ? mediaHeight : mediaWidth;
  const visualH = rotated ? mediaWidth : mediaHeight;
  const u = nx * visualW;
  const v = (1 - ny) * visualH;
  return visualToNative(u, v, mediaWidth, mediaHeight, rotation);
}

// Maps a point given in "visual" page space — x/y in PDF points, measured
// from the top-left of the page as it's displayed on screen after applying
// /Rotate — into native (unrotated) page coordinates. Factored out of
// normalizedToNative so image placement (which needs to rotate a point
// around an arbitrary center, not just remap a 0..1 normalized point) can
// reuse the same page-rotation handling.
function visualToNative(
  u: number,
  v: number,
  mediaWidth: number,
  mediaHeight: number,
  rotation: number,
): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: mediaWidth - v, y: u };
    case 180:
      return { x: mediaWidth - u, y: mediaHeight - v };
    case 270:
      return { x: v, y: mediaHeight - u };
    default:
      return { x: u, y: v };
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const v = parseInt(m[1], 16);
  return {
    r: ((v >> 16) & 0xff) / 255,
    g: ((v >> 8) & 0xff) / 255,
    b: (v & 0xff) / 255,
  };
}
